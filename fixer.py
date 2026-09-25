import os
from pathlib import Path
import tempfile
import logging

logger = logging.getLogger(__name__)

DOWNLOADS_DIR = os.environ.get("DOWNLOADS_DIR", "/media/Downloads")


def is_in_downloads(file_path):
    """Check if a path is inside Downloads."""
    try:
        path = Path(file_path).resolve()
        downloads_path = Path(DOWNLOADS_DIR).resolve()
        return path.is_relative_to(downloads_path)
    except (OSError, ValueError):
        return False


def is_in_media_library(file_path):
    """Check if file is in the Movies or Series directory."""
    try:
        path = Path(file_path).resolve()
        downloads_path = Path(DOWNLOADS_DIR).resolve()
        library_roots = (downloads_path.parent / "Movies", downloads_path.parent / "Series")
        return any(path.is_relative_to(root.resolve()) for root in library_roots)
    except Exception:
        return False


def find_download(file_path, source_path=None):
    """Validate the known Downloads source for a library file."""
    try:
        if not source_path:
            return None
        source = Path(source_path).resolve()
        if is_in_downloads(source) and source.is_file():
            return source
    except (OSError, ValueError):
        return None
    return None


def replace_with_download_hardlink(file_path, source_path=None):
    """Replace a library file with a hardlink to its Downloads counterpart."""
    target = Path(file_path)
    source = find_download(target, source_path)
    if source is None:
        return False

    temp_fd, temp_name = tempfile.mkstemp(prefix=f".{target.name}.", dir=target.parent)
    os.close(temp_fd)
    temp_path = Path(temp_name)
    try:
        temp_path.unlink()
        os.link(source, temp_path)
        os.replace(temp_path, target)
        logger.info(f"Replaced {target} with hardlink to {source}")
        return True
    except OSError as e:
        if temp_path.exists():
            temp_path.unlink()
        raise Exception(f"Failed to replace file with hardlink: {e}")


def migrate_hardlink(file_path, source_path=None):
    """Move the real file to a hardlink's path, leaving one link behind."""
    target = Path(file_path).resolve()
    source = Path(source_path).resolve() if source_path else None

    if not is_in_media_library(target):
        return False, "Hardlink destination is not in Movies or Series"
    if source is None or source == target:
        return False, "A different hardlink source path is required"
    if not source.is_file() or not target.is_file():
        return False, "Hardlink source and destination must be regular files"

    try:
        source_stat = source.stat()
        target_stat = target.stat()
    except OSError as e:
        return False, f"Unable to inspect hardlink: {e}"

    if (source_stat.st_dev, source_stat.st_ino) != (
        target_stat.st_dev,
        target_stat.st_ino,
    ):
        return False, "Source and destination are not hardlinks to the same file"

    try:
        source.unlink()
        logger.info(f"Migrated {source} to {target}")
        return True, f"Migrated real file to hardlink path: {target}"
    except OSError as e:
        raise Exception(f"Failed to migrate hardlink: {e}")


def remove_download(file_path):
    """Remove a file only when it is inside Downloads."""
    if not file_path:
        return False, "No Downloads source path was provided"

    path = Path(file_path).resolve()
    if not is_in_downloads(path):
        return False, "Source path is not inside Downloads"
    if not path.exists():
        return True, f"Downloads file was already removed: {path}"
    if not path.is_file():
        return False, "Downloads source is not a regular file"
    path.unlink()
    logger.info(f"Removed Downloads file: {path}")
    return True, f"Removed duplicate file from Downloads: {path}"


def remove_library_duplicate(file_path, source_path=None):
    """Remove the selected file from Movies or Series after a duplicate choice."""
    if not file_path:
        return False, "No library file path was provided"

    path = Path(file_path).resolve()
    source = Path(source_path).resolve() if source_path else None
    if not is_in_media_library(path):
        return False, "Selected file is not inside Movies or Series"
    if source is None or source == path or not is_in_media_library(source):
        return False, "A different duplicate file in Movies or Series is required"
    if not path.is_file() or not source.is_file():
        return False, "Selected duplicate files must be regular files"

    path.unlink()
    logger.info(f"Removed library duplicate: {path} (matched {source})")
    return True, f"Removed duplicate file from Movies or Series: {path}"


def fix_duplicate(file_path, source_path=None, action="hardlink"):
    """
    Replace a Movies/Series file with a hardlink to its Downloads counterpart.
    """
    results = {
        "success": False,
        "message": "",
        "actions_taken": []
    }

    try:
        logger.info(f"Fixing duplicate: {file_path}")

        if action == "remove_download":
            removed, message = remove_download(source_path)
            if removed:
                results["actions_taken"].append(
                    message
                )
                results["success"] = True
                results["message"] = message
                return results
            results["message"] = message
            return results

        if action == "remove_library_duplicate":
            removed, message = remove_library_duplicate(file_path, source_path)
            if removed:
                results["actions_taken"].append(message)
                results["success"] = True
                results["message"] = message
                return results
            results["message"] = message
            return results

        if action != "hardlink":
            results["message"] = f"Unknown fix action: {action}"
            return results

        if not is_in_media_library(file_path):
            results["message"] = "File is not in Movies or Series"
            return results

        if replace_with_download_hardlink(file_path, source_path):
            results["actions_taken"].append(
                "Replaced library file with hardlink to Downloads"
            )
            results["success"] = True
            results["message"] = (
                f"Replaced library file with Downloads hardlink: "
                f"{file_path} <- {source_path}"
            )
            return results

        results["message"] = "No matching file found in Downloads"
        return results

    except Exception as e:
        results["message"] = f"Error fixing duplicate: {e}"
        logger.error(f"Error fixing duplicate {file_path}: {e}")
        return results


def fix_hardlink(file_path, source_path=None, action="hardlink"):
    """Replace a Movies/Series file with its Downloads hardlink."""
    if action == "migrate":
        migrated, message = migrate_hardlink(file_path, source_path)
        return {
            "success": migrated,
            "message": message,
            "actions_taken": [message] if migrated else []
        }
    return fix_duplicate(file_path, source_path, action)


def fix_file(file_path, finding_type, source_path=None, action="hardlink"):
    """
    Main entry point for fixing file issues
    
    Args:
        file_path: Path to the file to fix
        finding_type: "duplicate" or "hardlink"
    
    Returns:
        Dictionary with success status and message
    """
    if finding_type == "duplicate":
        return fix_duplicate(file_path, source_path, action)
    elif finding_type == "hardlink":
        return fix_hardlink(file_path, source_path, action)
    else:
        return {
            "success": False,
            "message": f"Unknown finding type: {finding_type}"
        }
