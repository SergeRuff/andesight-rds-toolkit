const fs = require("fs");
const vscode = require("vscode");

let outputChannel;
let tailTimer;
let lastLogPath;
let tailState = {
    filePath: undefined,
    offset: 0,
    partial: ""
};

function getOutputChannel() {
    if (!outputChannel) {
        outputChannel = vscode.window.createOutputChannel("GDB Script");
    }

    return outputChannel;
}

function decodeMiString(value) {
    return value
        .replace(/\\n/g, "\n")
        .replace(/\\t/g, "\t")
        .replace(/\\"/g, "\"")
        .replace(/\\\\/g, "\\");
}

function cleanMiLine(line) {
    const match = line.match(/^[~&@]"(.*)"$/);
    if (!match) {
        return null;
    }

    return decodeMiString(match[1]);
}

function stopTail() {
    if (tailTimer) {
        clearInterval(tailTimer);
        tailTimer = undefined;
    }

    tailState = {
        filePath: undefined,
        offset: 0,
        partial: ""
    };
}

function readNewLogData(channel = getOutputChannel()) {
    if (!tailState.filePath) {
        return;
    }

    let stat;

    try {
        stat = fs.statSync(tailState.filePath);
    } catch {
        return;
    }

    if (stat.size < tailState.offset) {
        tailState.offset = 0;
        tailState.partial = "";
    }

    if (stat.size === tailState.offset) {
        return;
    }

    const fd = fs.openSync(tailState.filePath, "r");

    try {
        const length = stat.size - tailState.offset;
        const buffer = Buffer.alloc(length);

        fs.readSync(fd, buffer, 0, length, tailState.offset);
        tailState.offset = stat.size;

        const text = tailState.partial + buffer.toString("utf8");
        const lines = text.split(/\r?\n/);

        tailState.partial = lines.pop() || "";

        for (const line of lines) {
            const cleaned = cleanMiLine(line);

            if (cleaned !== null && cleaned.length > 0) {
                channel.append(cleaned);
            }
        }
    } finally {
        fs.closeSync(fd);
    }
}

function startTail(logPath) {
    stopTail();

    lastLogPath = logPath;

    const channel = getOutputChannel();
    channel.clear();
    channel.show(true);

    tailState = {
        filePath: logPath,
        offset: 0,
        partial: ""
    };

    tailTimer = setInterval(() => readNewLogData(channel), 200);
}

function resumeTail() {
    if (!tailTimer && lastLogPath) {
        startTail(lastLogPath);
    }
}

function deactivate() {
    stopTail();

    if (outputChannel) {
        outputChannel.dispose();
        outputChannel = undefined;
    }
}

module.exports = {
    deactivate,
    readNewLogData,
    resumeTail,
    startTail,
    stopTail
};
