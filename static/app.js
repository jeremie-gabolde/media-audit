let currentPage = 1;
const rowsPerPage = 50;
let statusTimer = null;
let resultsTimer = null;
let fixedItems = JSON.parse(sessionStorage.getItem("fixedMediaItems") || "{}");
let resultTimestamp = sessionStorage.getItem("mediaResultTimestamp") || "";

function fixedItemKey(filePath, findingType) {
    return `${filePath}|${findingType}`;
}

function fmtGB(bytes) {
    return (Number(bytes || 0) / 1024 / 1024 / 1024).toFixed(1) + " GB";
}

function formatTimestamp(timestamp) {
    if (!timestamp) return "";

    const value = String(timestamp);
    const date = new Date(/[zZ]|[+-]\d{2}:?\d{2}$/.test(value)
        ? value
        : `${value}Z`);
    if (Number.isNaN(date.getTime())) return value.replace("T", " ");

    const pad = number => String(number).padStart(2, "0");
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} `
        + `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

function applyView() {
    const rows = Array.from(document.querySelectorAll("#fileTable tbody tr"));
    const filterVal = (document.getElementById("filter")?.value || "").toLowerCase();
    const showAll = document.getElementById("showAll")?.checked;

    const matched = rows.filter(row => {
        const matchesFilter = row.innerText.toLowerCase().includes(filterVal);
        const hasIssue = row.dataset.hasFindings === "1";
        return matchesFilter && (showAll || hasIssue);
    });

    const totalPages = Math.max(1, Math.ceil(matched.length / rowsPerPage));
    if (currentPage > totalPages) currentPage = totalPages;
    if (currentPage < 1) currentPage = 1;

    rows.forEach(r => { r.style.display = "none"; });

    matched
        .slice((currentPage - 1) * rowsPerPage, currentPage * rowsPerPage)
        .forEach(r => { r.style.display = ""; });

    const pageInfo = document.getElementById("pageInfo");
    if (pageInfo) {
        pageInfo.textContent =
            `Page ${currentPage} / ${totalPages} (${matched.length} shown of ${rows.length})`;
    }
}

function changePage(delta) {
    currentPage += delta;
    applyView();
}

function fixFile(filePath, findingType, button, sourcePath = null) {
    const dialog = document.getElementById("fixDialog");
    const description = document.getElementById("fixDialogDescription");
    const hardlinkButton = document.getElementById("chooseHardlink");
    const removeButton = document.getElementById("chooseRemoveDownload");
    const libraryDuplicateOptions = document.getElementById("libraryDuplicateOptions");

    if (!dialog || !description || !hardlinkButton || !removeButton
        || !libraryDuplicateOptions) {
        submitFix(filePath, findingType, button, sourcePath, "hardlink");
        return;
    }

    const hasDownloadsSource = typeof sourcePath === "string"
        && sourcePath.split("/").includes("Downloads");
    const hasLibrarySource = typeof sourcePath === "string"
        && !hasDownloadsSource
        && (sourcePath.split("/").includes("Movies")
            || sourcePath.split("/").includes("Series"));
    const isDuplicate = findingType === "duplicate";
    const isLibraryDuplicate = isDuplicate && hasLibrarySource;
    hardlinkButton.disabled = !hasDownloadsSource;
    removeButton.disabled = !hasDownloadsSource;
    hardlinkButton.hidden = !hasDownloadsSource;
    removeButton.hidden = !hasDownloadsSource;
    libraryDuplicateOptions.hidden = !isLibraryDuplicate;
    libraryDuplicateOptions.replaceChildren();

    if (isLibraryDuplicate) {
        description.textContent = "Choose which library file to delete:";
        [
            { path: filePath, otherPath: sourcePath },
            { path: sourcePath, otherPath: filePath }
        ].forEach(({ path, otherPath }) => {
            const option = document.createElement("div");
            option.className = "library-duplicate-option";

            const pathLabel = document.createElement("span");
            pathLabel.className = "library-duplicate-path";
            pathLabel.textContent = path;
            pathLabel.title = path;

            const deleteButton = document.createElement("button");
            deleteButton.type = "button";
            deleteButton.className = "danger-button";
            deleteButton.textContent = "Delete";
            deleteButton.setAttribute("aria-label", `Delete ${path}`);
            deleteButton.onclick = () => {
                dialog.close();
                submitFix(
                    path,
                    findingType,
                    button,
                    otherPath,
                    "remove_library_duplicate"
                );
            };

            option.append(pathLabel, deleteButton);
            libraryDuplicateOptions.appendChild(option);
        });
    } else {
        description.textContent = `Choose how to fix ${filePath}`;
    }
    dialog.showModal();

    const closeDialog = () => dialog.close();
    hardlinkButton.onclick = () => {
        closeDialog();
        submitFix(filePath, findingType, button, sourcePath, "hardlink");
    };
    removeButton.onclick = () => {
        closeDialog();
        submitFix(filePath, findingType, button, sourcePath, "remove_download");
    };
}

function updateMetricsAfterFix(row, findingType, action, linkedPathCount) {
    const fileSize = Number(row?.dataset.fileSize || 0);
    const wastedSpace = document.getElementById("wastedSpace");
    const duplicateCount = document.getElementById("duplicateCount");
    const hardlinkCount = document.getElementById("hardlinkCount");

    if (findingType === "duplicate") {
        const currentWasted = Number(wastedSpace?.dataset.bytes || 0);
        if (wastedSpace) {
            const updatedWasted = Math.max(0, currentWasted - fileSize);
            wastedSpace.dataset.bytes = updatedWasted;
            wastedSpace.textContent = fmtGB(updatedWasted);
            updateStorageDisplay(updatedWasted);
        }
        if (duplicateCount) {
            duplicateCount.textContent = Math.max(
                0,
                Number(duplicateCount.textContent || 0) - 1
            );
        }
    }

    if (findingType === "hardlink" && action === "migrate"
        && linkedPathCount === 2 && hardlinkCount) {
        hardlinkCount.textContent = Math.max(
            0,
            Number(hardlinkCount.textContent || 0) - 1
        );
    }
}

function updateStorageDisplay(wasted) {
    const totalSpace = Number(document.getElementById("totalSpace")?.dataset.bytes || 0);
    const used = Math.max(0, totalSpace - wasted);
    const usedBar = document.getElementById("usedBar");
    const wastedBar = document.getElementById("wastedBar");
    const storageText = document.getElementById("storageText");

    if (totalSpace > 0) {
        if (usedBar) usedBar.style.width = `${used * 100 / totalSpace}%`;
        if (wastedBar) wastedBar.style.width = `${wasted * 100 / totalSpace}%`;
        if (storageText) {
            storageText.textContent = `Used: ${fmtGB(used)} | Wasted: ${fmtGB(wasted)}`;
        }
    }
}

function submitFix(filePath, findingType, button, sourcePath, action, linkedPathCount = 0) {
    button.disabled = true;
    button.textContent = "Fixing...";

    fetch("/api/fix", {
        method: "POST",
        headers: {
            "Content-Type": "application/json"
        },
        body: JSON.stringify({
            file_path: filePath,
            finding_type: findingType,
            source_path: sourcePath,
            action
        })
    })
        .then(r => {
            if (!r.ok) throw new Error(`HTTP ${r.status}`);
            return r.json();
        })
        .then(data => {
            if (data.success) {
                fixedItems[fixedItemKey(filePath, findingType)] = true;
                sessionStorage.setItem("fixedMediaItems", JSON.stringify(fixedItems));
                button.textContent = "✅ Fixed";
                button.className = "btn-fix btn-fix-success";
                const findingItem = button.closest(".finding-item");
                const row = button.closest("tr");
                updateMetricsAfterFix(row, findingType, action, linkedPathCount);
                if (findingItem) findingItem.remove();
                if (row && !row.querySelector(".finding-item")) {
                    row.dataset.hasFindings = "0";
                    row.cells[0].innerHTML = '<span class="status-ok">✅</span>';
                    row.cells[3].innerHTML = '<span class="status-ok">✅</span>';
                }
                applyView();
                showNotice(`Fixed: ${data.message}`, "success");
                fetchResults(false);
            } else {
                button.disabled = false;
                button.textContent = "Retry";
                button.className = "btn-fix";
                console.error("Media fix failed", {
                    filePath,
                    findingType,
                    sourcePath,
                    message: data.error || data.message
                });
                showNotice(`Failed to fix: ${data.error || data.message}`, "error");
            }
        })
        .catch(error => {
            button.disabled = false;
            button.textContent = "Retry";
            button.className = "btn-fix";
            console.error("Media fix request failed", {
                filePath,
                findingType,
                sourcePath,
                error
            });
            showNotice(`Error: ${error.message}`, "error");
        });
}

function showNotice(message, type) {
    const notice = document.getElementById("notice");
    if (!notice) return;
    notice.textContent = message;
    notice.className = `notice notice-${type}`;
}

function renderHistory(history) {
    const historyContent = document.getElementById("historyContent");
    if (!historyContent) return;

    if (!Array.isArray(history) || history.length === 0) {
        historyContent.textContent = "No history available.";
        return;
    }

    historyContent.textContent = history
        .slice()
        .reverse()
        .map(item => {
            if (item.type === "fix") {
                return `${formatTimestamp(item.timestamp)} — FIX: ${item.message || "Fix completed"}`;
            }

            const wasted = fmtGB(item.wasted_space || 0);
            const duplicateCount = item.duplicate_count ?? item.duplicates ?? 0;
            const duration = item.duration_seconds ?? item.duration ?? 0;
            return `${formatTimestamp(item.timestamp)} — wasted ${wasted}, ${duplicateCount} duplicate group(s), ${duration}s`;
        })
        .join("\n");
}

function appendPathPart(container, path, differenceStart, differenceEnd) {
    if (differenceStart === differenceEnd) {
        container.appendChild(document.createTextNode(path));
        return;
    }

    container.appendChild(document.createTextNode(path.slice(0, differenceStart)));
    const difference = document.createElement("mark");
    difference.className = "path-difference";
    difference.textContent = path.slice(differenceStart, differenceEnd);
    container.appendChild(difference);
    container.appendChild(document.createTextNode(path.slice(differenceEnd)));
}

function appendPathComparison(
    container,
    currentPath,
    linkedPath,
    currentLabel = "This path: ",
    linkedLabel = "Linked path: "
) {
    let prefixLength = 0;
    while (prefixLength < currentPath.length
        && prefixLength < linkedPath.length
        && currentPath[prefixLength] === linkedPath[prefixLength]) {
        prefixLength += 1;
    }

    let suffixLength = 0;
    while (suffixLength < currentPath.length - prefixLength
        && suffixLength < linkedPath.length - prefixLength
        && currentPath[currentPath.length - suffixLength - 1]
            === linkedPath[linkedPath.length - suffixLength - 1]) {
        suffixLength += 1;
    }

    const currentLine = document.createElement("div");
    currentLine.className = "hardlink-path current-path";
    currentLine.appendChild(document.createTextNode(currentLabel));
    appendPathPart(
        currentLine,
        currentPath,
        prefixLength,
        currentPath.length - suffixLength
    );
    container.appendChild(currentLine);

    const linkedLine = document.createElement("div");
    linkedLine.className = "hardlink-path linked-path";
    linkedLine.appendChild(document.createTextNode(linkedLabel));
    appendPathPart(
        linkedLine,
        linkedPath,
        prefixLength,
        linkedPath.length - suffixLength
    );
    container.appendChild(linkedLine);
}

function clearHistory() {
    if (!window.confirm("Clear all scan and fix history? Media files will not be changed.")) {
        return;
    }

    const button = document.getElementById("clearHistoryBtn");
    if (button) {
        button.disabled = true;
        button.textContent = "Clearing...";
    }

    fetch("/api/history/clear", {
        method: "POST",
        headers: { "Content-Type": "application/json" }
    })
        .then(response => response.json().then(data => ({
            ok: response.ok,
            data
        })))
        .then(({ ok, data }) => {
            if (!ok || !data.success) {
                throw new Error(data.error || "Unable to clear history");
            }
            window.location.reload();
        })
        .catch(error => {
            if (button) {
                button.disabled = false;
                button.textContent = "Clear history";
            }
            showNotice(`Failed to clear history: ${error.message}`, "error");
        });
}

function buildFindingsCell(findings, filePath) {
    const cell = document.createElement("td");

    if (!findings || findings.length === 0) {
        const span = document.createElement("span");
        span.className = "status-ok";
        span.textContent = "✅";
        cell.appendChild(span);
        return cell;
    }

    const container = document.createElement("div");
    container.className = "findings-container";

    findings.forEach((finding, index) => {
        const item = document.createElement("div");
        item.className = "finding-item";

        if (finding.type === "duplicate") {
            const span = document.createElement("span");
            span.className = "status-error";
            span.title = `Duplicate of: ${finding.matched_path}`;
            span.textContent = "🚨";
            item.appendChild(span);

            const paths = document.createElement("div");
            paths.className = "finding-text hardlink-paths duplicate-paths";
            paths.title = finding.matched_path;
            appendPathComparison(
                paths,
                filePath,
                finding.matched_path,
                "This path: ",
                "Duplicate path: "
            );
            item.appendChild(paths);

            const fixBtn = document.createElement("button");
            fixBtn.className = "btn-fix";
            fixBtn.textContent = "Fix";
            fixBtn.onclick = () => fixFile(
                filePath,
                "duplicate",
                fixBtn,
                finding.matched_path
            );
            item.appendChild(fixBtn);
        } else if (finding.type === "hardlink") {
            const span = document.createElement("span");
            span.textContent = "🔗";
            item.appendChild(span);

            const otherPaths = finding.linked_paths.filter(p => p !== filePath);
            const paths = document.createElement("div");
            paths.className = "finding-text hardlink-paths";
            paths.title = otherPaths.join("\n");
            if (otherPaths.length > 0) {
                appendPathComparison(paths, filePath, otherPaths[0]);
            }
            if (otherPaths.length > 1) {
                const count = document.createElement("div");
                count.textContent = ` +${otherPaths.length - 1} more linked path(s)`;
                paths.appendChild(count);
            }
            item.appendChild(paths);

            const isLibraryPath = filePath.split("/").some(
                pathPart => pathPart === "Movies" || pathPart === "Series"
            );
            if (isLibraryPath && otherPaths.length > 0) {
                const migrateBtn = document.createElement("button");
                migrateBtn.className = "btn-fix";
                migrateBtn.textContent = "Migrate";
                migrateBtn.title = "Move the real file here and remove this hardlink";
                migrateBtn.onclick = () => submitFix(
                    filePath,
                    "hardlink",
                    migrateBtn,
                    otherPaths[0],
                    "migrate",
                    finding.linked_paths.length
                );
                item.appendChild(migrateBtn);
            }
        }

        container.appendChild(item);
    });

    cell.appendChild(container);
    return cell;
}

function buildTable(files) {
    const tbody = document.querySelector("#fileTable tbody");
    if (!tbody) return;

    const fragment = document.createDocumentFragment();

    files.forEach(file => {
        const findings = (file.findings || []).filter(finding =>
            !fixedItems[fixedItemKey(file.path, finding.type)]
        );
        const hasFindings = findings.length > 0;

        const tr = document.createElement("tr");
        tr.dataset.hasFindings = hasFindings ? "1" : "0";
        tr.dataset.fileSize = file.size || 0;

        const statusTd = document.createElement("td");
        if (hasFindings) {
            const hasError = findings.some(f => f.severity === "error");
            const hasWarning = findings.some(f => f.severity === "warning");
            const statusSpan = document.createElement("span");
            statusSpan.className = hasError
                ? "status-error"
                : hasWarning
                    ? "status-warning"
                    : "status-info";
            statusSpan.title = findings.map(f => f.message).join("; ");
            statusSpan.textContent = hasError ? "🚨" : hasWarning ? "⚠️" : "ℹ️";
            statusTd.appendChild(statusSpan);
        } else {
            const statusSpan = document.createElement("span");
            statusSpan.className = "status-ok";
            statusSpan.textContent = "✅";
            statusTd.appendChild(statusSpan);
        }
        tr.appendChild(statusTd);

        const pathTd = document.createElement("td");
        pathTd.textContent = file.path || "";
        tr.appendChild(pathTd);

        const sizeTd = document.createElement("td");
        sizeTd.textContent = fmtGB(file.size);
        tr.appendChild(sizeTd);

        // Build findings cell with Fix buttons
        const findingsTd = buildFindingsCell(findings, file.path);
        findingsTd.dataset.path = file.path;
        tr.appendChild(findingsTd);

        fragment.appendChild(tr);
    });

    tbody.innerHTML = "";
    tbody.appendChild(fragment);

    const fileCount = document.getElementById("fileCount");
    if (fileCount) fileCount.textContent = files.length;

    currentPage = 1;
    applyView();
}

function renderResults(data) {
    if (!data.partial && data.timestamp && data.timestamp !== resultTimestamp) {
        fixedItems = {};
        resultTimestamp = data.timestamp;
        sessionStorage.setItem("fixedMediaItems", "{}");
        sessionStorage.setItem("mediaResultTimestamp", resultTimestamp);
    }

    const totalSpace = document.getElementById("totalSpace");
    const wastedSpace = document.getElementById("wastedSpace");
    const duplicateCount = document.getElementById("duplicateCount");
    const hardlinkCount = document.getElementById("hardlinkCount");

    if (totalSpace) {
        totalSpace.dataset.bytes = data.total_space || 0;
        totalSpace.textContent = fmtGB(data.total_space);
    }
    if (wastedSpace) {
        wastedSpace.dataset.bytes = data.wasted_space || 0;
        wastedSpace.textContent = fmtGB(data.wasted_space);
    }
    if (duplicateCount) duplicateCount.textContent = data.duplicate_count || 0;
    if (hardlinkCount) hardlinkCount.textContent = data.hardlink_count || 0;

    const total = data.total_space || 0;
    const wasted = data.wasted_space || 0;
    const used = total - wasted;
    const usedPct = total > 0 ? (used * 100 / total) : 0;
    const wastedPct = total > 0 ? (wasted * 100 / total) : 0;

    const usedBar = document.getElementById("usedBar");
    const wastedBar = document.getElementById("wastedBar");
    const storageText = document.getElementById("storageText");

    if (usedBar) usedBar.style.width = usedPct + "%";
    if (wastedBar) wastedBar.style.width = wastedPct + "%";
    if (storageText) {
        storageText.textContent = total > 0
            ? `Used: ${fmtGB(used)} | Wasted: ${fmtGB(wasted)}`
            : "No media files have been scanned yet.";
    }

    if (data.files) {
        buildTable(data.files);
    }
    renderHistory(data.history);
}

function fetchResults(updateDashboard = true) {
    fetch("/api/results")
        .then(r => r.json())
        .then(data => {
            if (data && Object.keys(data).length) {
                if (updateDashboard) {
                    renderResults(data);
                } else {
                    renderHistory(data.history);
                }
            }
        })
        .catch(() => {});
}

function updateStatus() {
    fetch("/api/status")
        .then(r => r.json())
        .then(data => {
            const phase = document.getElementById("scanPhase");
            const text = document.getElementById("progressText");
            const bar = document.getElementById("progressBar");
            const scanBtn = document.getElementById("scanBtn");

            if (phase) phase.textContent = data.phase || "Idle";
            if (scanBtn) {
                scanBtn.disabled = !!data.running;
                if (!data.running) scanBtn.textContent = "Run Scan";
            }

            if (data.total > 0) {
                const percent = (data.current / data.total) * 100;
                if (bar) bar.style.width = percent + "%";
                if (text) text.textContent = `${data.current} / ${data.total}`;
            } else {
                if (bar) bar.style.width = "0%";
                if (text) text.textContent = "0 / 0";
            }

            // Poll the heavier /api/results endpoint only while a scan
            // is actually running (so the page updates live), plus one
            // final fetch right after it finishes.
            if (data.running) {
                if (!resultsTimer) {
                    fetchResults();
                    resultsTimer = setInterval(fetchResults, 3000);
                }
            } else if (resultsTimer) {
                clearInterval(resultsTimer);
                resultsTimer = null;
                fetchResults();
            }

            clearTimeout(statusTimer);
            statusTimer = setTimeout(updateStatus, data.running ? 1000 : 10000);
        })
        .catch(() => {
            clearTimeout(statusTimer);
            statusTimer = setTimeout(updateStatus, 10000);
        });
}

function sortTable(column) {
    const table = document.getElementById("fileTable");
    const tbody = table.tBodies[0];
    const rows = Array.from(tbody.rows);

    rows.sort((a, b) =>
        a.cells[column]
            .innerText
            .localeCompare(
                b.cells[column].innerText,
                undefined,
                { numeric: true }
            )
    );

    rows.forEach(row => tbody.appendChild(row));
    applyView();
}

document.addEventListener("DOMContentLoaded", () => {

    const filter = document.getElementById("filter");
    const showAll = document.getElementById("showAll");
    const clearHistoryButton = document.getElementById("clearHistoryBtn");
    const scanForm = document.querySelector('form[action="/scan"]');
    const scanButton = document.getElementById("scanBtn");

    if (scanForm) {
        scanForm.addEventListener("submit", event => {
            event.preventDefault();
            if (scanButton) {
                scanButton.disabled = true;
                scanButton.textContent = "Starting scan...";
            }
            const phase = document.getElementById("scanPhase");
            if (phase) phase.textContent = "Starting scan...";

            fetch("/scan", { method: "POST" })
                .then(response => {
                    if (!response.ok) throw new Error(`HTTP ${response.status}`);
                    updateStatus();
                })
                .catch(error => {
                    if (scanButton) {
                        scanButton.disabled = false;
                        scanButton.textContent = "Run Scan";
                    }
                    showNotice(`Unable to start scan: ${error.message}`, "error");
                });
        });
    }

    if (clearHistoryButton) {
        clearHistoryButton.addEventListener("click", clearHistory);
    }

    if (filter) {
        filter.addEventListener("input", () => {
            currentPage = 1;
            applyView();
        });
    }

    if (showAll) {
        showAll.addEventListener("change", () => {
            currentPage = 1;
            applyView();
        });
    }

    applyView();
    fetchResults();
    updateStatus();
});
