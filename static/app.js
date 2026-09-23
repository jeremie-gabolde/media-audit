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

    if (!dialog || !description || !hardlinkButton || !removeButton) {
        submitFix(filePath, findingType, button, sourcePath, "hardlink");
        return;
    }

    description.textContent = `Choose how to fix ${filePath}`;
    const hasDownloadsSource = typeof sourcePath === "string"
        && sourcePath.split("/").includes("Downloads");
    hardlinkButton.disabled = !hasDownloadsSource;
    removeButton.disabled = !hasDownloadsSource;
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

function submitFix(filePath, findingType, button, sourcePath, action) {
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
                if (findingItem) findingItem.remove();
                if (row && !row.querySelector(".finding-item")) {
                    row.dataset.hasFindings = "0";
                    row.cells[0].innerHTML = '<span class="status-ok">✅</span>';
                    row.cells[3].innerHTML = '<span class="status-ok">✅</span>';
                }
                applyView();
                showNotice(`Fixed: ${data.message}`, "success");
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

            const text = document.createElement("span");
            text.className = "finding-text";
            text.textContent = ` Duplicate: ${finding.matched_path}`;
            item.appendChild(text);

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

            const text = document.createElement("span");
            text.className = "finding-text";
            const otherPaths = finding.linked_paths.filter(p => p !== filePath);
            text.title = otherPaths.join("\n");
            text.textContent = ` Hardlinked (${finding.linked_paths.length}): ${otherPaths.slice(0, 1).join(", ")}`;
            if (otherPaths.length > 1) {
                text.textContent += ` +${otherPaths.length - 1}`;
            }
            item.appendChild(text);

            const fixBtn = document.createElement("button");
            fixBtn.className = "btn-fix";
            fixBtn.textContent = "Fix";
            const downloadPath = finding.linked_paths.find(path =>
                path.split("/").includes("Downloads")
            );
            fixBtn.onclick = () => fixFile(
                filePath,
                "hardlink",
                fixBtn,
                downloadPath
            );
            item.appendChild(fixBtn);
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

        const statusTd = document.createElement("td");
        if (hasFindings) {
            const hasError = findings.some(f => f.severity === "error");
            const statusSpan = document.createElement("span");
            statusSpan.className = hasError ? "status-error" : "status-warning";
            statusSpan.title = findings.map(f => f.message).join("; ");
            statusSpan.textContent = hasError ? "🚨" : "⚠️";
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

    if (totalSpace) totalSpace.textContent = fmtGB(data.total_space);
    if (wastedSpace) wastedSpace.textContent = fmtGB(data.wasted_space);
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
}

function fetchResults() {
    fetch("/api/results")
        .then(r => r.json())
        .then(data => {
            if (data && Object.keys(data).length) {
                renderResults(data);
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
            if (scanBtn) scanBtn.disabled = !!data.running;

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
