import json
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

DATA_DIR = "data"
RESULTS_FILE = os.path.join(DATA_DIR, "results.json")

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


@app.route("/")
def index():
    return render_template("index.html", data=load_results())


@app.route("/api/results")
def api_results():
    return jsonify(load_results())


@app.route("/api/status")
def api_status():
    return jsonify(scan_status)


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
        if action not in {"hardlink", "remove_download"}:
            return jsonify({"success": False, "error": "Invalid action"}), 400
        if source_path is not None and not isinstance(source_path, str):
            return jsonify({"success": False, "error": "Missing parameters"}), 400
        if scan_status["running"]:
            return jsonify({"success": False, "error": "Scan is running; try again when it finishes"}), 409

        result = fixer.fix_file(file_path, finding_type, source_path, action)
        return jsonify(result)

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
