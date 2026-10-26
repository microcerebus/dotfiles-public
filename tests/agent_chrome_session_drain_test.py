#!/usr/bin/env python3
"""The session's launcher and watchdog survive a drained socket.

Node's "pipe" is a socketpair, and libuv closes the session's copy of the
child's end right after the spawn. If something holds an iocount on that fd at
that moment (lsof does, and any agent may run it), XNU's
fileproc_drain marks the socket SS_DRAINING for good, and every read on it that
would block fails with EBADF, in every process.

This test makes that state on purpose, as the session's handoff would: the
child gets one end, and the test closes its own copy while a thread of its own
is blocked reading it. It then drives the real launcher and watchdog strings,
read from scripts/agent-chrome-session, with the bytes the session writes.

Pure: no network, no ports, writes nothing. Every process it starts has a
group of its own, and the watchdog only ever gets a group the test made.
Run: python3 -I tests/agent_chrome_session_drain_test.py
AGENT_CHROME_SESSION=<path> runs the same cases against another copy.
"""
import errno
import os
import re
import signal
import socket
import struct
import subprocess
import threading
import time
import unittest
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
HELPER = Path(os.environ.get("AGENT_CHROME_SESSION", REPO / "scripts/agent-chrome-session"))
SOURCE = HELPER.read_text()


def js_string(pattern):
    """The single-quoted JS string the pattern's group 1 captures, unescaped."""
    match = re.search(pattern, SOURCE, re.M)
    if not match:
        raise AssertionError(f"{HELPER} has no match for {pattern}")
    return match.group(1).replace("\\'", "'").replace("\\\\", "\\")


def js_byte(pattern):
    match = re.search(pattern, SOURCE)
    if not match:
        raise AssertionError(f"{HELPER} has no match for {pattern}")
    return {"\\n": b"\n"}.get(match.group(1), match.group(1).encode())


LAUNCHER = js_string(r"^const LAUNCHER = '(.*)';$")
try:
    WATCHDOG = js_string(r"^const WATCHDOG = '(.*)';$")
except AssertionError:  # older copies inline it in lifeline()
    WATCHDOG = js_string(r"""spawn\("/bin/sh", \["-c", '(.*?)', "sh", String\(group\)\]""")
RELEASE = js_byte(r'release\.end\("(\\n|.)"\)')
ENDED = js_byte(r'watchdog\.stdin\.end\("(\\n|.)"')


def drain(fd):
    """Close fd while a thread of ours is blocked reading it, then prove the
    socket is drained: a read that would block on a copy fails with EBADF."""
    probe = os.dup(fd)
    reader = threading.Thread(target=lambda: _read_quietly(fd), daemon=True)
    reader.start()
    time.sleep(0.1)
    os.close(fd)
    reader.join(2)
    s = socket.socket(fileno=probe)
    s.setsockopt(socket.SOL_SOCKET, socket.SO_RCVTIMEO, struct.pack("ll", 0, 1000))
    try:
        s.recv(1)
        drained = False
    except BlockingIOError:
        drained = False
    except OSError as error:
        drained = error.errno == errno.EBADF
    finally:
        s.close()
    if not drained:
        raise AssertionError("the socket did not drain; the test cannot make the state it checks")


def _read_quietly(fd):
    try:
        os.read(fd, 1)
    except OSError:
        pass


def handoff():
    """A socketpair as libuv makes it for a "pipe": (session end, child end)."""
    session_end, child_end = socket.socketpair()
    return session_end.detach(), child_end.detach()


def finish(session_fd, then, delay):
    """After delay, write `then` (bytes) or nothing, then close: EOF."""
    time.sleep(delay)
    try:
        if then:
            os.write(session_fd, then)
    except BrokenPipeError:  # the reader is gone; the session ignores this too
        pass
    os.close(session_fd)


class Launcher(unittest.TestCase):
    """The launcher runs the command only after the release byte."""

    def run_launcher(self, drained, then, delay=0.2):
        session_fd, child_fd = handoff()
        # The outer shell only moves the child end to fd 3; the launcher
        # string itself runs unchanged in the inner shell.
        move = 'eval "exec 3<&$0 $0<&-"; exec /bin/sh -c "$@"'
        child = subprocess.Popen(
            ["/bin/sh", "-c", move, str(child_fd), LAUNCHER, "sh", "/bin/echo", "command ran"],
            pass_fds=[child_fd], start_new_session=True,
            stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        try:
            if drained:
                drain(child_fd)
            else:
                os.close(child_fd)
            finish(session_fd, then, delay)
            out, err = child.communicate(timeout=20)
        finally:
            if child.poll() is None and child.pid > 1:
                os.killpg(child.pid, signal.SIGKILL)
                child.wait()
        return child.returncode, out, err

    def test_data_runs_the_command(self):
        self.assertEqual(self.run_launcher(False, RELEASE)[:2], (0, "command ran\n"))

    def test_eof_exits_1_before_the_command(self):
        self.assertEqual(self.run_launcher(False, None)[:2], (1, ""))

    def test_drained_then_data_runs_the_command(self):
        code, out, err = self.run_launcher(True, RELEASE)
        self.assertEqual((code, out), (0, "command ran\n"), err)

    def test_drained_then_eof_exits_1_before_the_command(self):
        self.assertEqual(self.run_launcher(True, None)[:2], (1, ""))

    def test_drained_for_good_gives_up_loudly_before_the_command(self):
        code, out, err = self.run_launcher(True, None, delay=5)
        self.assertEqual((code, out), (1, ""))
        self.assertIn("the command did not start", err)
        self.assertIn("Bad file descriptor", err)


class Watchdog(unittest.TestCase):
    """The watchdog SIGKILLs the command's group only on EOF."""

    def run_watchdog(self, drained, then, delay=0.2):
        # The command: a group the test made. Its pid is its group id, and
        # it is not the test's own group, so a kill can reach nothing else.
        command = subprocess.Popen(["/bin/sleep", "30"], start_new_session=True)
        group = command.pid
        self.assertGreater(group, 1)
        self.assertEqual(os.getpgid(group), group)
        self.assertNotEqual(group, os.getpgrp())
        session_fd, child_fd = handoff()
        watchdog = subprocess.Popen(["/bin/sh", "-c", WATCHDOG, "sh", str(group)],
                                    stdin=child_fd, start_new_session=True,
                                    stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        try:
            if drained:
                drain(child_fd)
            else:
                os.close(child_fd)
            finish(session_fd, then, delay)
            code = watchdog.wait(timeout=20)
            time.sleep(0.1)
            alive = command.poll() is None
            return code, alive, command.returncode
        finally:
            for p in (watchdog, command):
                if p.poll() is None and p.pid > 1 and os.getpgid(p.pid) == p.pid:
                    os.killpg(p.pid, signal.SIGKILL)
                    p.wait()

    def test_data_leaves_the_command_alone(self):
        code, alive, _ = self.run_watchdog(False, ENDED)
        self.assertTrue(alive)
        self.assertEqual(code, 0)

    def test_eof_kills_the_group(self):
        _, alive, status = self.run_watchdog(False, None)
        self.assertFalse(alive)
        self.assertEqual(status, -signal.SIGKILL)

    def test_drained_then_data_leaves_the_command_alone(self):
        code, alive, _ = self.run_watchdog(True, ENDED)
        self.assertTrue(alive, f"the watchdog killed a healthy command (exit {code})")
        self.assertEqual(code, 0)

    def test_drained_then_eof_kills_the_group(self):
        _, alive, status = self.run_watchdog(True, None)
        self.assertFalse(alive)
        self.assertEqual(status, -signal.SIGKILL)

    def test_drained_for_good_never_kills_a_healthy_command(self):
        code, alive, _ = self.run_watchdog(True, None, delay=12)
        self.assertTrue(alive, f"the watchdog killed a healthy command (exit {code})")
        self.assertEqual(code, 3)


if __name__ == "__main__":
    unittest.main(verbosity=2)
