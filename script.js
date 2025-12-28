const _magic_ctrlc_string = "__WASM_REPL_CTRLC_" + (Date.now()) + "__";

// Detect if browser supports PyREPL (Chrome/Chromium with JSPI)
function supportsPyREPL() {
    const isChrome = /Chrome/.test(navigator.userAgent) && /Google Inc/.test(navigator.vendor);
    const isEdge = /Edg/.test(navigator.userAgent);
    return isChrome || isEdge;
}

class WorkerManager {
    constructor(
        workerURL,
        standardIO,
        readyCallBack,
        finishedCallback,
    ) {
        this.workerURL = workerURL;
        this.worker = null;
        this.standardIO = standardIO;
        this.readyCallBack = readyCallBack;
        this.finishedCallback = finishedCallback;

        this.initialiseWorker();
    }

    async initialiseWorker() {
        if (!this.worker) {
            this.worker = new Worker(this.workerURL, {
                type: "module",
            });
            this.worker.addEventListener(
                "message",
                this.handleMessageFromWorker,
            );
        }
    }

    async run(options) {
        this.worker.postMessage({
            type: "run",
            args: options.args || [],
            files: options.files || {},
        });
    }

    reset() {
        if (this.worker) {
            this.worker.terminate();
            this.worker = null;
        }
        this.standardIO.message("Worker process terminated.");
        this.initialiseWorker();
    }

    handleStdinData(inputValue) {
        if (this.stdinbuffer && this.stdinbufferInt) {
            let startingIndex = 1;
            if (this.stdinbufferInt[0] > 0) {
                startingIndex = this.stdinbufferInt[0];
            }
            const data = new TextEncoder().encode(inputValue);
            data.forEach((value, index) => {
                this.stdinbufferInt[startingIndex + index] = value;
            });

            this.stdinbufferInt[0] =
                startingIndex + data.length - 1;
            Atomics.notify(this.stdinbufferInt, 0, 1);
        }
    }

    handleMessageFromWorker = (event) => {
        const type = event.data.type;
        if (type === "ready") {
            this.readyCallBack();
        } else if (type === "stdout") {
            this.standardIO.stdout(event.data.stdout);
        } else if (type === "stderr") {
            this.standardIO.stderr(event.data.stderr);
        } else if (type === "stdin") {
            // Leave it to the terminal to decide whether to chunk it into lines
            // or send characters depending on the use case.
            this.stdinbuffer = event.data.buffer;
            this.stdinbufferInt = new Int32Array(this.stdinbuffer);
            this.standardIO.stdin().then((inputValue) => {
                this.handleStdinData(inputValue);
            });
        } else if (type === "finished") {
            this.standardIO.message(
                `Exited with status: ${event.data.returnCode}`,
            );
            this.finishedCallback();
        }
    };
}

class WasmTerminal {
    constructor() {
        try {
            this.history = JSON.parse(sessionStorage.getItem('__python_wasm_repl.history'));
            this.historyBuffer = this.history.slice();
        } catch(e) {
            this.history = [];
            this.historyBuffer = [];
        }
        this.reset();

        this.xterm = new Terminal({
            scrollback: 10000,
            fontSize: 14,
            theme: {
                background: "#0a0e1a",
                foreground: "#f1f5f9",
                cursor: "#6366f1",
                cursorAccent: "#0a0e1a",
            },
            cols: 100,
            fontFamily: "'JetBrains Mono', monospace",
        });

        this.xterm.onKey((keyEvent) => {
            // Fix for iOS Keyboard Jumping on space
            if (keyEvent.key === " ") {
                keyEvent.domEvent.preventDefault();
            }
        });

        this.xterm.onData(this.handleTermData);
    }

    reset() {
        this.inputBuffer = new BufferQueue();
        this.input = "";
        this.resolveInput = null;
        this.activeInput = false;
        this.inputStartCursor = null;

        this.cursorPosition = 0;
        this.historyIndex = -1;
        this.beforeHistoryNav = "";
    }

    open(container) {
        this.xterm.open(container);
    }

    handleTermData = (data) => {
        const ord = data.charCodeAt(0);
        data = data.replace(/\r(?!\n)/g, "\n"); // Convert lone CRs to LF

        // Handle pasted data
        if (data.length > 1 && data.includes("\n")) {
            let alreadyWrittenChars = 0;
            // If line already had data on it, merge pasted data with it
            if (this.input != "") {
                this.inputBuffer.addData(this.input);
                alreadyWrittenChars = this.input.length;
                this.input = "";
            }
            this.inputBuffer.addData(data);
            // If input is active, write the first line
            if (this.activeInput) {
                let line = this.inputBuffer.nextLine();
                this.writeLine(line.slice(alreadyWrittenChars));
                this.resolveInput(line);
                this.activeInput = false;
            }
            // When input isn't active, add to line buffer
        } else if (!this.activeInput) {
            // Skip non-printable characters
            if (!(ord === 0x1b || ord == 0x7f || ord < 32)) {
                this.inputBuffer.addData(data);
            }
            // TODO: Handle more escape sequences?
        } else if (ord === 0x1b) {
            // Handle special characters
            switch (data.slice(1)) {
                case "[A": // up
                    this.historyBack();
                    break;
                case "[B": // down
                    this.historyForward();
                    break;
                case "[C": // right
                    this.cursorRight();
                    break;
                case "[D": // left
                    this.cursorLeft();
                    break;
                case "[H": // home key
                    this.cursorHome(true);
                    break;
                case "[F": // end key
                    this.cursorEnd(true);
                    break;
                case "[3~": // delete key
                    this.deleteAtCursor();
                    break;
                default:
                    break;
            }
        } else if (ord < 32 || ord === 0x7f) {
            switch (data) {
                case "\x0c": // CTRL+L
                    this.clear();
                    break;
                case "\n": // ENTER
                case "\x0a": // CTRL+J
                case "\x0d": // CTRL+M
                    this.resolveInput(
                        this.input + this.writeLine("\n"),
                    );
                    this.input = "";
                    this.cursorPosition = 0;
                    this.activeInput = false;
                    break;
                case "\x03": // CTRL+C
                    this.input = "";
                    this.cursorPosition = 0;
                    this.historyIndex = -1;
                    this.resolveInput(_magic_ctrlc_string + "\n");
                    break;
                case "\x09": // TAB
                    this.handleTab();
                    break;
                case "\x7F": // BACKSPACE
                case "\x08": // CTRL+H
                    this.handleCursorErase(true);
                    break;
                case "\x04": // CTRL+D
                    // Send empty input
                    if (this.input === "") {
                        this.resolveInput("");
                        this.cursorPosition = 0;
                        this.activeInput = false;
                    }
            }
        } else {
            this.handleCursorInsert(data);
            this.updateHistory();
        }
    };

    clearLine() {
        this.xterm.write("\x1b[K");
    }

    writeLine(line) {
        this.xterm.write(line.slice(0, -1));
        this.xterm.write("\r\n");
        return line;
    }

    handleCursorInsert(data) {
        const trailing = this.input.slice(this.cursorPosition);
        this.input =
            this.input.slice(0, this.cursorPosition) +
            data +
            trailing;
        this.cursorPosition += data.length;
        this.xterm.write(data);
        if (trailing.length !== 0) {
            this.xterm.write(trailing);
            this.xterm.write("\x1b[" + trailing.length + "D");
        }
        this.updateHistory();
    }

    handleTab() {
        // handle tabs: from the current position, add spaces until
        // this.cursorPosition is a multiple of 4.
        const prefix = this.input.slice(0, this.cursorPosition);
        const suffix = this.input.slice(this.cursorPosition);
        const count = 4 - (this.cursorPosition % 4);
        const toAdd = " ".repeat(count);
        this.input = prefix + toAdd + suffix;
        this.cursorHome(false);
        this.clearLine();
        this.xterm.write(this.input);
        if (suffix) {
            this.xterm.write("\x1b[" + suffix.length + "D");
        }
        this.cursorPosition += count;
        this.updateHistory();
    }

    handleCursorErase() {
        // Don't delete past the start of input
        if (
            this.xterm.buffer.active.cursorX <=
            this.inputStartCursor
        ) {
            return;
        }
        const trailing = this.input.slice(this.cursorPosition);
        this.input =
            this.input.slice(0, this.cursorPosition - 1) + trailing;
        this.cursorLeft();
        this.clearLine();
        if (trailing.length !== 0) {
            this.xterm.write(trailing);
            this.xterm.write("\x1b[" + trailing.length + "D");
        }
        this.updateHistory();
    }

    deleteAtCursor() {
        if (this.cursorPosition < this.input.length) {
            const trailing = this.input.slice(
                this.cursorPosition + 1,
            );
            this.input =
                this.input.slice(0, this.cursorPosition) + trailing;
            this.clearLine();
            if (trailing.length !== 0) {
                this.xterm.write(trailing);
                this.xterm.write("\x1b[" + trailing.length + "D");
            }
            this.updateHistory();
        }
    }

    cursorRight() {
        if (this.cursorPosition < this.input.length) {
            this.cursorPosition += 1;
            this.xterm.write("\x1b[C");
        }
    }

    cursorLeft() {
        if (this.cursorPosition > 0) {
            this.cursorPosition -= 1;
            this.xterm.write("\x1b[D");
        }
    }

    cursorHome(updatePosition) {
        if (this.cursorPosition > 0) {
            this.xterm.write("\x1b[" + this.cursorPosition + "D");
            if (updatePosition) {
                this.cursorPosition = 0;
            }
        }
    }

    cursorEnd() {
        if (this.cursorPosition < this.input.length) {
            this.xterm.write(
                "\x1b[" +
                    (this.input.length - this.cursorPosition) +
                    "C",
            );
            this.cursorPosition = this.input.length;
        }
    }

    updateHistory() {
        if (this.historyIndex !== -1) {
            this.historyBuffer[this.historyIndex] = this.input;
        } else {
            this.beforeHistoryNav = this.input;
        }
    }

    historyBack() {
        if (this.history.length === 0) {
            return;
        } else if (this.historyIndex === -1) {
            // we're not currently navigating the history; store
            // the current command and then look at the end of our
            // history buffer
            this.beforeHistoryNav = this.input;
            this.historyIndex = this.history.length - 1;
        } else if (this.historyIndex > 0) {
            this.historyIndex -= 1;
        }
        this.input = this.historyBuffer[this.historyIndex];
        this.cursorHome(false);
        this.clearLine();
        this.xterm.write(this.input);
        this.cursorPosition = this.input.length;
    }

    historyForward() {
        if (this.history.length === 0 || this.historyIndex === -1) {
            // we're not currently navigating the history; NOP.
            return;
        } else if (this.historyIndex < this.history.length - 1) {
            this.historyIndex += 1;
            this.input = this.historyBuffer[this.historyIndex];
        } else if (this.historyIndex == this.history.length - 1) {
            // we're coming back from the last history value; reset
            // the input to whatever it was when we started going
            // through the history
            this.input = this.beforeHistoryNav;
            this.historyIndex = -1;
        }
        this.cursorHome(false);
        this.clearLine();
        this.xterm.write(this.input);
        this.cursorPosition = this.input.length;
    }

    prompt = async () => {
        this.activeInput = true;
        // Hack to allow stdout/stderr to finish before we figure out where input starts
        setTimeout(() => {
            this.inputStartCursor =
                this.xterm.buffer.active.cursorX;
        }, 1);
        // If line buffer has a line ready, send it immediately
        if (this.inputBuffer.hasLineReady()) {
            return new Promise((resolve, reject) => {
                resolve(
                    this.writeLine(this.inputBuffer.nextLine()),
                );
                this.activeInput = false;
            });
            // If line buffer has an incomplete line, use it for the active line
        } else if (this.inputBuffer.lastLineIsIncomplete()) {
            // Hack to ensure cursor input start doesn't end up after user input
            setTimeout(() => {
                this.handleCursorInsert(
                    this.inputBuffer.nextLine()
                );
            }, 1);
        }
        return new Promise((resolve, reject) => {
            this.resolveInput = (value) => {
                if (
                    value.replace(/\s/g, "").length != 0 &&
                    value != _magic_ctrlc_string + "\n"
                ) {
                    if (this.historyIndex !== -1) {
                        this.historyBuffer[this.historyIndex] =
                            this.history[this.historyIndex];
                    }
                    this.history.push(value.slice(0, -1));
                    this.historyBuffer.push(value.slice(0, -1));
                    this.historyIndex = -1;
                    this.cursorPosition = 0;
                    try {
                        sessionStorage.setItem('__python_wasm_repl.history', JSON.stringify(this.history));
                    } catch(e) {
                    }
                }
                resolve(value);
            };
        });
    };

    clear() {
        this.xterm.clear();
    }

    print(charCode) {
        let array = [charCode];
        if (charCode == 10) {
            array = [13, 10]; // Replace \n with \r\n
        }
        this.xterm.write(new Uint8Array(array));
    }
}

class BufferQueue {
    constructor(xterm) {
        this.buffer = [];
    }

    isEmpty() {
        return this.buffer.length == 0;
    }

    lastLineIsIncomplete() {
        return (
            !this.isEmpty() &&
            !this.buffer[this.buffer.length - 1].endsWith("\n")
        );
    }

    hasLineReady() {
        return !this.isEmpty() && this.buffer[0].endsWith("\n");
    }

    addData(data) {
        let lines = data.match(/.*(\n|$)/g);
        if (this.lastLineIsIncomplete()) {
            this.buffer[this.buffer.length - 1] += lines.shift();
        }
        for (let line of lines) {
            this.buffer.push(line);
        }
    }

    nextLine() {
        return this.buffer.shift();
    }
}

const runButton = document.getElementById("run");
const replButton = document.getElementById("repl");
const stopButton = document.getElementById("stop");
const clearButton = document.getElementById("clear");

window.onload = () => {
    const terminal = new WasmTerminal();
    terminal.open(document.getElementById("terminal"));

    let replTerminal = null;

    // Show appropriate REPL notice based on browser
    const replNotice = document.getElementById("repl-notice");
    if (supportsPyREPL()) {
        replNotice.style.display = "block";
        replNotice.innerHTML = '<strong>🚀 PyREPL Mode:</strong> Enhanced REPL with syntax highlighting, better editing, and multiline support.';
    } else {
        replNotice.style.display = "block";
        replNotice.style.background = "rgba(245, 158, 11, 0.15)";
        replNotice.style.borderColor = "var(--warning)";
        replNotice.innerHTML = '<strong>⚠️ Basic REPL Mode:</strong> Using fallback REPL. For enhanced PyREPL with syntax highlighting, please use Chrome or Edge.';
    }

    const stdio = {
        stdout: (charCode) => {
            terminal.print(charCode);
        },
        stderr: (charCode) => {
            terminal.print(charCode);
        },
        stdin: async () => {
            return await terminal.prompt();
        },
        message: (text) => {
            terminal.writeLine(`\r\n${text}\r\n`);
        },
    };

    const programRunning = (isRunning) => {
        if (isRunning) {
            runButton.setAttribute("disabled", true);
            stopButton.removeAttribute("disabled");
        } else {
            runButton.removeAttribute("disabled");
            stopButton.setAttribute("disabled", true);
        }
    };

    runButton.addEventListener("click", (e) => {
        terminal.clear();
        terminal.reset();
        programRunning(true);
        const code = editor.getValue();
        pythonWorkerManager.run({
            args: ["main.py"],
            files: { "main.py": code },
        });
    });

    stopButton.addEventListener("click", (e) => {
        programRunning(false);
        pythonWorkerManager.reset();
    });

    clearButton.addEventListener("click", (e) => {
        terminal.clear();
    });

    const readyCallback = () => {
        runButton.removeAttribute("disabled");
        clearButton.removeAttribute("disabled");
    };

    const finishedCallback = () => {
        programRunning(false);
        pythonWorkerManager.reset();
    };

    const pythonWorkerManager = new WorkerManager(
        `./python.worker.mjs?v=${Date.now()}`,
        stdio,
        readyCallback,
        finishedCallback,
    );

    // Mode tab switching with PyREPL initialization
    let replStarted = false;
    let usePyREPL = supportsPyREPL();

    document.querySelectorAll('.mode-tab').forEach(tab => {
        tab.addEventListener('click', async () => {
            const mode = tab.dataset.mode;

            // Update active tab
            document.querySelectorAll('.mode-tab').forEach(t => t.classList.remove('active'));
            tab.classList.add('active');

            // Update active content
            document.querySelectorAll('.mode-content').forEach(c => c.classList.remove('active'));
            document.getElementById(`${mode}-mode`).classList.add('active');

            // Initialize REPL when switching to REPL mode
            if (mode === 'repl' && !replStarted) {
                replStarted = true;
                if (usePyREPL) {
                    await initPyREPL();
                } else {
                    await initBasicREPL();
                }
            }
        });
    });

    // PyREPL buttons
    const replRestartButton = document.getElementById("repl-restart");
    const replClearButton = document.getElementById("repl-clear");

    replClearButton.addEventListener("click", () => {
        if (replTerminal) {
            replTerminal.clear();
        }
    });

    replRestartButton.addEventListener("click", async () => {
        if (replTerminal) {
            const container = document.getElementById("terminal-repl");
            container.innerHTML = '';
            replTerminal = null;
        }
        if (replWorkerManager) {
            replWorkerManager.reset();
        }
        replRestartButton.setAttribute("disabled", true);
        replClearButton.setAttribute("disabled", true);
        if (usePyREPL) {
            await initPyREPL();
        } else {
            await initBasicREPL();
        }
    });

    // Basic REPL initialization (for non-Chrome browsers)
    let replWorkerManager = null;
    async function initBasicREPL() {
        const container = document.getElementById("terminal-repl");
        container.innerHTML = '';

        const replWasmTerminal = new WasmTerminal();
        replWasmTerminal.open(container);
        replTerminal = replWasmTerminal;

        const replStdio = {
            stdout: (charCode) => replWasmTerminal.print(charCode),
            stderr: (charCode) => replWasmTerminal.print(charCode),
            stdin: async () => await replWasmTerminal.prompt(),
            message: (text) => replWasmTerminal.writeLine(`\r\n${text}\r\n`),
        };

        const REPL = `
import sys
import code

import builtins

def _interrupt_aware_input(prompt=''):
line = builtins.input(prompt)
if line.strip() == "${_magic_ctrlc_string}":
raise KeyboardInterrupt()
return line

cprt = 'Type "help", "copyright", "credits" or "license" for more information.'
banner = f'Python {sys.version} on {sys.platform}\\n{cprt}'

code.interact(banner=banner, readfunc=_interrupt_aware_input, exitmsg='')
`;

        const replReadyCallback = () => {
            replRestartButton.removeAttribute("disabled");
            replClearButton.removeAttribute("disabled");
            replWorkerManager.run({ args: ["-c", REPL], files: {} });
        };

        const replFinishedCallback = () => {
            replStdio.message("REPL session ended.");
            replRestartButton.removeAttribute("disabled");
        };

        replWorkerManager = new WorkerManager(
            `./python.worker.mjs?v=${Date.now()}`,
            replStdio,
            replReadyCallback,
            replFinishedCallback,
        );
    }

    // PyREPL initialization
    async function initPyREPL() {
        const { openpty } = await import("https://unpkg.com/xterm-pty/index.mjs");
        await import("https://unpkg.com/@xterm/xterm/lib/xterm.js");

        const createEmscriptenModule = (await import(`./python.mjs?v=${Date.now()}`)).default;

        replTerminal = new Terminal({
            scrollback: 10000,
            fontSize: 14,
            theme: {
                background: "#0a0e1a",
                foreground: "#f1f5f9",
                cursor: "#6366f1",
                cursorAccent: "#0a0e1a",
            },
            fontFamily: "'JetBrains Mono', monospace",
        });
        replTerminal.open(document.getElementById("terminal-repl"));

        const { master, slave: PTY } = openpty();
        replTerminal.loadAddon(master);
        globalThis.PTY = PTY;

        const tty_ops = {
            ioctl_tcgets: () => {
                const termios = PTY.ioctl("TCGETS");
                return {
                    c_iflag: termios.iflag,
                    c_oflag: termios.oflag,
                    c_cflag: termios.cflag,
                    c_lflag: termios.lflag,
                    c_cc: termios.cc,
                };
            },
            ioctl_tcsets: (_tty, _optional_actions, data) => {
                PTY.ioctl("TCSETS", {
                    iflag: data.c_iflag,
                    oflag: data.c_oflag,
                    cflag: data.c_cflag,
                    lflag: data.c_lflag,
                    cc: data.c_cc,
                });
                return 0;
            },
            ioctl_tiocgwinsz: () => PTY.ioctl("TIOCGWINSZ").reverse(),
            get_char: () => { throw new Error("Should not happen"); },
            put_char: () => { throw new Error("Should not happen"); },
            fsync: () => {},
        };

        const POLLIN = 1;
        const POLLOUT = 4;
        const waitResult = { READY: 0, SIGNAL: 1, TIMEOUT: 2 };

        function onReadable() {
            var handle;
            var promise = new Promise((resolve) => {
                handle = PTY.onReadable(() => resolve(waitResult.READY));
            });
            return [promise, handle];
        }

        function onSignal() {
            var handle = { dispose() {} };
            var promise = new Promise((resolve) => {});
            return [promise, handle];
        }

        function onTimeout(timeout) {
            var id;
            var promise = new Promise((resolve) => {
                if (timeout > 0) {
                    id = setTimeout(resolve, timeout, waitResult.TIMEOUT);
                }
            });
            var handle = {
                dispose() {
                    if (id) clearTimeout(id);
                },
            };
            return [promise, handle];
        }

        async function waitForReadable(timeout) {
            let p1, p2, p3, h1, h2, h3;
            try {
                [p1, h1] = onReadable();
                [p2, h2] = onTimeout(timeout);
                [p3, h3] = onSignal();
                return await Promise.race([p1, p2, p3]);
            } finally {
                h1.dispose();
                h2.dispose();
                h3.dispose();
            }
        }

        const FIONREAD = 0x541b;
        const tty_stream_ops = {
            async readAsync(stream, buffer, offset, length, pos) {
                let readBytes = PTY.read(length);
                if (length && !readBytes.length) {
                    const status = await waitForReadable(-1);
                    if (status === waitResult.READY) {
                        readBytes = PTY.read(length);
                    } else {
                        throw new Error("Not implemented");
                    }
                }
                buffer.set(readBytes, offset);
                return readBytes.length;
            },
            write: (stream, buffer, offset, length) => {
                buffer = new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
                const toWrite = Array.from(buffer.subarray(offset, offset + length));
                PTY.write(toWrite);
                return length;
            },
            async pollAsync(stream, timeout) {
                if (!PTY.readable && timeout) {
                    await waitForReadable(timeout);
                }
                return (PTY.readable ? POLLIN : 0) | (PTY.writable ? POLLOUT : 0);
            },
            ioctl(stream, request, varargs) {
                if (request === FIONREAD) {
                    const res = PTY.fromLdiscToUpperBuffer.length;
                    window.Module.HEAPU32[varargs / 4] = res;
                    return 0;
                }
                throw new Error("Unimplemented ioctl request");
            },
        };

        async function setupStdlib(Module) {
            const versionInt = Module.HEAPU32[Module._Py_Version >>> 2];
            const major = (versionInt >>> 24) & 0xff;
            const minor = (versionInt >>> 16) & 0xff;
            Module.FS.mkdirTree(`/lib/python${major}.${minor}/lib-dynload/`);
            const resp = await fetch(`python${major}.${minor}.zip?v=${Date.now()}`);
            const stdlibBuffer = await resp.arrayBuffer();
            Module.FS.writeFile(`/lib/python${major}${minor}.zip`, new Uint8Array(stdlibBuffer), { canOwn: true });
        }

        async function setupStdio(Module) {
            Object.assign(Module.TTY.default_tty_ops, tty_ops);
            Object.assign(Module.TTY.stream_ops, tty_stream_ops);
        }

        const emscriptenSettings = {
            async preRun(Module) {
                Module.addRunDependency("pre-run");
                Module.ENV.TERM = "xterm-256color";
                window.Module = Module;
                await Promise.all([setupStdlib(Module), setupStdio(Module)]);
                Module.removeRunDependency("pre-run");
            },
        };

        try {
            await createEmscriptenModule(emscriptenSettings);
            replRestartButton.removeAttribute("disabled");
            replClearButton.removeAttribute("disabled");
        } catch (e) {
            console.warn(e);
            if (window.Module) {
                window.Module.__Py_DumpTraceback(2, window.Module._PyGILState_GetThisThreadState());
            }
        }
    }
};

var editor;
document.addEventListener("DOMContentLoaded", () => {
    editor = ace.edit("editor");
    editor.session.setMode("ace/mode/python");
    editor.setTheme("ace/theme/monokai");
    editor.setOptions({
        fontSize: "14px",
        showPrintMargin: false,
        highlightActiveLine: true,
    });
});
