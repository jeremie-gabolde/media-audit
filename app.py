import json
import hmac
import logging
import os
from datetime import datetime
from threading import Lock, Thread

from flask import Flask, render_template, redirect, jsonify, request

from apscheduler.schedulers.background import BackgroundScheduler

import scanner
import fixer

app = Flask(__name__)
logger = logging.getLogger(__name__)


AUTH_USERNAME = os.environ.get("MEDIA_AUDIT_USERNAME", "")
AUTH_PASSWORD = os.environ.get("MEDIA_AUDIT_PASSWORD", "")

if AUTH_USERNAME and AUTH_PASSWORD:
    logger.info("HTTP authentication enabled for user %r", AUTH_USERNAME)
else:
    logger.error("MEDIA_AUDIT_USERNAME and MEDIA_AUDIT_PASSWORD must be configured")


def authentication_required():
    response = jsonify({"success": False, "error": "Authentication required"})
    response.status_code = 401
    response.headers["WWW-Authenticate"] = 'Basic realm="Media Audit"'
    return response


@app.before_request
def require_authentication():
    if not AUTH_USERNAME or not AUTH_PASSWORD:
        return jsonify({"success": False, "error": "Authentication is not configured"}), 503

    credentials = request.authorization
    if not credentials:
        return authentication_required()
    if not hmac.compare_digest(credentials.username, AUTH_USERNAME):
        logger.warning("Rejected authentication for username %r", credentials.username)
        return authentication_required()
    if not hmac.compare_digest(credentials.password, AUTH_PASSWORD):
        logger.warning("Rejected authentication for username %r", credentials.username)
        return authentication_required()

DATA_DIR = "data"
RESULTS_FILE = os.path.join(DATA_DIR, "results.json")
HISTORY_FILE = os.path.join(DATA_DIR, "history.json")
HISTORY_LIMIT = 30

SCAN_INTERVAL_DAYS = int(os.environ.get("SCAN_INTERVAL_DAYS", "7"))

scan_status = {
    "running": False,
    "phase": "Idle",
    "current": 0,
    "total": 0
}
scan_lock = Lock()


def run_scan_background():
    if not scan_lock.acquire(blocking=False):
        return

    scan_status["running"] = True

    try:
        scanner.scan(scan_status)
    except Exception as e:
        scan_status["phase"] = f"Error: {e}"
    finally:
        scan_status["running"] = False
        scan_lock.release()


def scheduled_scan():
    Thread(target=run_scan_background, daemon=True).start()


scheduler = BackgroundScheduler(daemon=True)
scheduler.add_job(
    scheduled_scan,
    trigger="interval",
    days=SCAN_INTERVAL_DAYS,
    next_run_time=datetime.now(),
)
scheduler.start()


def load_results():
    if not os.path.exists(RESULTS_FILE):
        return {}
    try:
        with open(RESULTS_FILE, "r", encoding="utf-8") as f:
            return json.load(f)
    except (json.JSONDecodeError, OSError):
        return {}


def save_json(path, data):
    """Write JSON atomically so readers never see a partial file."""
    os.makedirs(DATA_DIR, exist_ok=True)
    temporary_path = f"{path}.tmp"
    with open(temporary_path, "w", encoding="utf-8") as f:
        json.dump(data, f, indent=2)
    os.replace(temporary_path, path)


def record_fix(file_path, finding_type, source_path, action, result):
    """Append a successful fix action to the persistent history."""
    history = scanner.load_json(HISTORY_FILE, [])
    if not isinstance(history, list):
        history = []
    history.append({
        "timestamp": datetime.now().isoformat(timespec="seconds"),
        "type": "fix",
        "action": action,
        "finding_type": finding_type,
        "file_path": file_path,
        "source_path": source_path,
        "message": result.get("message", "Fix completed")
    })
    history = history[-HISTORY_LIMIT:]
    save_json(HISTORY_FILE, history)

    results = load_results()
    if results:
        results["history"] = history
        save_json(RESULTS_FILE, results)


def update_results_after_fix(file_path, finding_type, source_path, action):
    """Keep persisted scan results consistent until the next full scan."""
    results = load_results()
    if not results or not isinstance(results.get("files"), list):
        return

    files = results["files"]
    target = next((item for item in files if item.get("path") == file_path), None)

    if finding_type == "duplicate":
        if target is None:
            return
        results["wasted_space"] = max(
            0, results.get("wasted_space", 0) - target.get("size", 0)
        )
        results["duplicate_count"] = max(
            0, results.get("duplicate_count", 0) - 1
        )
        target["findings"] = [
            finding for finding in target.get("findings", [])
            if finding.get("type") != "duplicate"
        ]
        if action == "remove_download" and source_path:
            files[:] = [item for item in files if item.get("path") != source_path]

    elif finding_type == "hardlink" and action == "migrate" and target:
        files[:] = [item for item in files if item.get("path") != source_path]
        remaining_paths = [item.get("path") for item in files]
        linked_records = [
            item for item in files
            if source_path in item.get("linked_paths", [])
            or file_path in item.get("linked_paths", [])
        ]
        linked_records = [
            item for item in linked_records if item.get("path") in remaining_paths
        ]
        linked_paths = [item.get("path") for item in linked_records]

        if len(linked_paths) < 2:
            results["hardlink_count"] = max(
                0, results.get("hardlink_count", 0) - 1
            )

        for item in linked_records:
            item["linked_paths"] = linked_paths
            if len(linked_paths) < 2:
                item["findings"] = [
                    finding for finding in item.get("findings", [])
                    if finding.get("type") != "hardlink"
                ]
            else:
                for finding in item.get("findings", []):
                    if finding.get("type") == "hardlink":
                        finding["linked_paths"] = linked_paths

    save_json(RESULTS_FILE, results)


@app.route("/")
def index():
    return render_template("index.html", data=load_results())


@app.route("/api/results")
def api_results():
    return jsonify(load_results())


@app.route("/api/status")
def api_status():
    return jsonify(scan_status)


@app.route("/api/history/clear", methods=["POST"])
def clear_history():
    """Clear scan and fix history without modifying media files."""
    if not scan_lock.acquire(blocking=False):
        return jsonify({
            "success": False,
            "error": "Scan or fix is running; try again when it finishes"
        }), 409

    try:
        save_json(HISTORY_FILE, [])
        results = load_results()
        if results:
            results["history"] = []
            save_json(RESULTS_FILE, results)
        logger.info("History cleared by authenticated user %r", AUTH_USERNAME)
        return jsonify({"success": True, "message": "History cleared"})
    except OSError as e:
        logger.exception("Failed to clear history")
        return jsonify({"success": False, "error": str(e)}), 500
    finally:
        scan_lock.release()


@app.route("/scan", methods=["POST"])
def manual_scan():
    if not scan_status["running"]:
        Thread(target=run_scan_background, daemon=True).start()
    return redirect("/")


@app.route("/api/fix", methods=["POST"])
def api_fix():
    """
    Fix a specific issue with a file.
    
    Request body:
    {
        "file_path": "/path/to/file",
        "finding_type": "duplicate|hardlink"
    }
    """
    file_path = None
    finding_type = None
    source_path = None
    action = None

    try:
        data = request.get_json(silent=True)
        if not isinstance(data, dict):
            return jsonify({"success": False, "error": "JSON object required"}), 400

        file_path = data.get("file_path")
        finding_type = data.get("finding_type")
        source_path = data.get("source_path")
        action = data.get("action", "hardlink")

        if not isinstance(file_path, str) or not file_path:
            return jsonify({"success": False, "error": "file_path must be a string"}), 400
        if finding_type not in {"duplicate", "hardlink"}:
            return jsonify({"success": False, "error": "Invalid finding_type"}), 400
        if action not in {"hardlink", "remove_download", "migrate"}:
            return jsonify({"success": False, "error": "Invalid action"}), 400
        if action == "migrate" and finding_type != "hardlink":
            return jsonify({"success": False, "error": "Migrate is only valid for hardlinks"}), 400
        if source_path is not None and not isinstance(source_path, str):
            return jsonify({"success": False, "error": "Missing parameters"}), 400
        if not scan_lock.acquire(blocking=False):
            return jsonify({"success": False, "error": "Scan is running; try again when it finishes"}), 409

        try:
            result = fixer.fix_file(file_path, finding_type, source_path, action)
            if result.get("success"):
                update_results_after_fix(file_path, finding_type, source_path, action)
                record_fix(file_path, finding_type, source_path, action, result)
            return jsonify(result)
        finally:
            scan_lock.release()

    except Exception as e:
        logger.exception(
            "Fix request failed: file_path=%r finding_type=%r source_path=%r action=%r",
            file_path,
            finding_type,
            source_path,
            action,
        )
        return jsonify({"success": False, "error": str(e)}), 500


if __name__ == "__main__":
    os.makedirs(DATA_DIR, exist_ok=True)
    app.run(host="0.0.0.0", port=8080, debug=False, threaded=True)
