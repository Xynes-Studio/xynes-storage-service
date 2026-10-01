package main

import (
	"bufio"
	"bytes"
	"context"
	"encoding/binary"
	"errors"
	"io"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"syscall"
	"testing"
	"time"
)

func fakeReply(t *testing.T, text string) func() (net.Conn, error) {
	t.Helper()
	return func() (net.Conn, error) {
		a, b := net.Pipe()
		go func() {
			defer b.Close()
			command := make([]byte, 6)
			io.ReadFull(b, command)
			if strings.HasPrefix(string(command), "zPING") {
				io.WriteString(b, "PONG\x00")
				return
			}
			io.ReadFull(b, make([]byte, 4))
			for {
				var n uint32
				if binary.Read(b, binary.BigEndian, &n) != nil {
					return
				}
				if n == 0 {
					break
				}
				io.CopyN(io.Discard, b, int64(n))
			}
			io.WriteString(b, text+"\x00")
		}()
		return a, nil
	}
}
func TestDaemon(t *testing.T) {
	d := daemon{command: func() *exec.Cmd { return exec.Command("sleep", "10") }, dial: fakeReply(t, "stream: OK"), startupTimeout: time.Second}
	if err := d.start(); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	for _, b := range [][]byte{nil, bytes.Repeat([]byte("A"), 70000)} {
		reply, err := d.scan(ctx, b)
		if err != nil || reply != "stream: OK" {
			t.Fatalf("%q %v", reply, err)
		}
	}
	d.stop()
	d.stop()
	d.command = func() *exec.Cmd { return exec.Command("false") }
	d.dial = func() (net.Conn, error) { return nil, errors.New("down") }
	d.pollInterval = time.Millisecond
	if d.start() == nil {
		t.Fatal("exited daemon accepted")
	}
	d.command = func() *exec.Cmd { return exec.Command("/nonexistent") }
	if d.start() == nil {
		t.Fatal("missing daemon accepted")
	}
	d.command = func() *exec.Cmd { return exec.Command("sleep", "10") }
	d.startupTimeout = 5 * time.Millisecond
	d.dial = func() (net.Conn, error) { return nil, errors.New("down") }
	if d.start() == nil || d.cmd != nil {
		t.Fatal("startup timeout did not reap")
	}
	if _, err := d.scan(ctx, []byte("hello")); err == nil {
		t.Fatal("dial error accepted")
	}
	d.dial = fakeReply(t, strings.Repeat("A", 4096))
	if _, err := d.scan(ctx, nil); err == nil {
		t.Fatal("oversized response accepted")
	}
}
func wire(b []byte) []byte {
	var out bytes.Buffer
	out.WriteString("zINSTREAM\x00")
	binary.Write(&out, binary.BigEndian, uint32(len(b)))
	out.Write(b)
	binary.Write(&out, binary.BigEndian, uint32(0))
	return out.Bytes()
}
func roundtrip(g *gateway, b []byte) string {
	a, c := net.Pipe()
	done := make(chan struct{})
	go func() { g.handle(c); close(done) }()
	a.SetDeadline(time.Now().Add(3 * time.Second))
	go func() { a.Write(wire(b)) }()
	out, _ := io.ReadAll(a)
	a.Close()
	<-done
	return string(out)
}
func TestGateway(t *testing.T) {
	p := smallPolicy()
	p.WallMS = 2000
	dir := t.TempDir()
	child := filepath.Join(dir, "validator")
	os.WriteFile(child, []byte("#!/bin/sh\nprintf ''\n"), 0700)
	d := &daemon{dial: fakeReply(t, "stream: OK")}
	g := &gateway{p: p, daemon: d, slot: make(chan struct{}, 1), self: child}
	if got := roundtrip(g, []byte("hello")); got != "stream: OK\x00" {
		t.Fatal(got)
	}
	if got := roundtrip(g, bytes.Repeat([]byte("A"), 4097)); !strings.Contains(got, "StreamMaxLength") {
		t.Fatal(got)
	}
	os.WriteFile(child, []byte("#!/bin/sh\nprintf 'MaxFiles'\n"), 0700)
	if got := roundtrip(g, []byte("hello")); !strings.Contains(got, "MaxFiles") {
		t.Fatal(got)
	}
	g.self = "/nonexistent"
	if got := roundtrip(g, []byte("hello")); !strings.Contains(got, "ERROR") {
		t.Fatal(got)
	}
	// exec avoids subprocess descendants; the owned validator is killed/reaped.
	os.WriteFile(child, []byte("#!/bin/sh\nexec sleep 10\n"), 0700)
	g.self = child
	g.p.WallMS = 20
	if got := roundtrip(g, []byte("hello")); !strings.Contains(got, "MaxScanTime") {
		t.Fatal(got)
	}
	g.slot <- struct{}{}
	a, b := net.Pipe()
	go g.handle(b)
	out, _ := io.ReadAll(a)
	a.Close()
	if !strings.Contains(string(out), "busy ERROR") {
		t.Fatal(string(out))
	}
	<-g.slot
}
func TestConfiguration(t *testing.T) {
	p, err := loadPolicy(map[string]string{})
	if err != nil {
		t.Fatal(err)
	}
	config := p.config("/var/lib/clamav")
	for _, s := range []string{"MaxThreads 1", "MaxQueue 2", "MaxRecursion 5", "MaxFileSize 67108864", "MaxScanSize 134217728", "MaxFiles 512", "MaxScanTime 5000", "StreamMaxLength 67108864", "AlertExceedsMax yes", "TCPAddr 127.0.0.1"} {
		if !strings.Contains(config, s) {
			t.Fatal(s)
		}
	}
	for _, env := range []map[string]string{{"CLAMD_CONF_StreamMaxLength": "bad"}, {"CLAMD_CONF_MaxFileSize": "1"}, {"CLAMD_CONF_WallTime": "5000"}, {"CLAMD_CONF_MaxFiles": "-1"}} {
		if _, err := loadPolicy(env); err == nil {
			t.Fatal(env)
		}
	}
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	if _, err := runBounded(ctx, exec.Command("false")); err == nil {
		t.Fatal("failure accepted")
	}
	if _, err := runBounded(ctx, exec.Command("/nonexistent")); err == nil {
		t.Fatal("missing executable accepted")
	}
}

func TestEnvironmentAndStartupFailureState(t *testing.T) {
	t.Setenv("CLAMD_CONF_MaxScanSize", "2000")
	if environment()["CLAMD_CONF_MaxScanSize"] != "2000" {
		t.Fatal("missing environment")
	}
	for _, key := range []string{"ScanArchive", "AlertExceedsMax", "AlertEncrypted"} {
		if _, err := loadPolicy(map[string]string{"CLAMD_CONF_" + key: "no"}); err == nil {
			t.Fatal("unsafe config accepted")
		}
	}
	d := daemon{command: func() *exec.Cmd { return exec.Command("/nonexistent") }}
	if d.start() == nil {
		t.Fatal("missing binary accepted")
	}
	d.stop()
	if d.cmd != nil {
		t.Fatal("failed command retained")
	}
}

func TestMainValidationEntry(t *testing.T) {
	f := filepath.Join(t.TempDir(), "harmless")
	os.WriteFile(f, []byte("hello"), 0600)
	previous := os.Args
	defer func() { os.Args = previous }()
	os.Args = []string{"scanner", "validate", f}
	main()
}
func TestGatewayReapsDaemonBeforeDeadlineVerdict(t *testing.T) {
	p := smallPolicy()
	p.WallMS = 1000
	child := filepath.Join(t.TempDir(), "validator")
	os.WriteFile(child, []byte("#!/bin/sh\nprintf ''\n"), 0700)
	d := &daemon{command: func() *exec.Cmd { return exec.Command("sleep", "10") }, dial: fakeReply(t, "stream: OK")}
	if err := d.start(); err != nil {
		t.Fatal(err)
	}
	old := d.cmd.Process
	d.dial = func() (net.Conn, error) {
		a, b := net.Pipe()
		go func() { defer b.Close(); io.Copy(io.Discard, b) }()
		return a, nil
	}
	d.command = func() *exec.Cmd { return exec.Command("/nonexistent") }
	fatal := false
	g := &gateway{p: p, daemon: d, slot: make(chan struct{}, 1), self: child, onFatal: func() { fatal = true }}
	if got := roundtrip(g, []byte("hello")); !strings.Contains(got, "MaxScanTime") {
		t.Fatal(got)
	}
	if err := old.Signal(syscall.Signal(0)); err == nil {
		t.Fatal("old daemon not reaped")
	}
	if !fatal {
		t.Fatal("unavailable restart not reported")
	}
}

type testListener struct {
	c      net.Conn
	closed chan struct{}
	once   sync.Once
	handed chan struct{}
}

func (l *testListener) Accept() (net.Conn, error) {
	select {
	case <-l.closed:
		return nil, net.ErrClosed
	default:
	}
	if l.c != nil {
		c := l.c
		l.c = nil
		close(l.handed)
		return c, nil
	}
	<-l.closed
	return nil, net.ErrClosed
}
func (l *testListener) Close() error   { l.once.Do(func() { close(l.closed) }); return nil }
func (l *testListener) Addr() net.Addr { return &net.TCPAddr{} }
func TestServeCancelsAndWaitsForActiveInput(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	a, b := net.Pipe()
	defer a.Close()
	l := &testListener{c: b, closed: make(chan struct{}), handed: make(chan struct{})}
	g := &gateway{p: smallPolicy(), slot: make(chan struct{}, 1)}
	done := make(chan struct{})
	go func() { serve(ctx, l, g); close(done) }()
	select {
	case <-l.handed:
	case <-time.After(time.Second):
		t.Fatal("connection not served")
	}
	// No frame terminator: shutdown must interrupt the input read and wait for cleanup.
	cancel()
	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("shutdown did not complete")
	}
	if n, _ := a.Read(make([]byte, 1)); n != 0 {
		t.Fatal("connection still open")
	}
}

func TestDaemonScanCancellationClosesPrivateSocket(t *testing.T) {
	a, b := net.Pipe()
	defer b.Close()
	d := daemon{dial: func() (net.Conn, error) { return a, nil }}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	done := make(chan error, 1)
	go func() { _, err := d.scan(ctx, []byte("hello")); done <- err }()
	cancel()
	select {
	case err := <-done:
		if err == nil {
			t.Fatal("cancelled scan accepted")
		}
	case <-time.After(100 * time.Millisecond):
		t.Fatal("private scan ignored cancellation")
	}
}

func TestSupervisorUnixSocket(t *testing.T) {
	dir, err := os.MkdirTemp("/tmp", "xyn-unix-")
	if err != nil {
		t.Fatal(err)
	}
	defer os.RemoveAll(dir)
	path := filepath.Join(dir, "scanner.sock")
	unixListener, err := listenScannerSocket(path)
	if err != nil {
		t.Fatal(err)
	}
	defer unixListener.Close()
	info, err := os.Stat(path)
	if err != nil || info.Mode().Perm() != 0660 {
		t.Fatalf("socket permissions: %v %v", info, err)
	}
	tcpListener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer tcpListener.Close()
	child := filepath.Join(dir, "validator")
	if err := os.WriteFile(child, []byte("#!/bin/sh\nprintf ''\n"), 0700); err != nil {
		t.Fatal(err)
	}
	p := smallPolicy()
	p.WallMS = 2000
	g := &gateway{p: p, daemon: &daemon{dial: fakeReply(t, "stream: OK")}, slot: make(chan struct{}, 1), self: child}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	done := make(chan struct{})
	go func() { serve(ctx, tcpListener, g, unixListener); close(done) }()
	scan := func(network, address string, b []byte) string {
		t.Helper()
		c, err := net.DialTimeout(network, address, time.Second)
		if err != nil {
			t.Fatal(err)
		}
		defer c.Close()
		c.SetDeadline(time.Now().Add(3 * time.Second))
		// Every required application scan includes the metadata preamble.
		if _, err := c.Write(append([]byte("zXYNES application/zip\x00"), wire(b)...)); err != nil {
			t.Fatal(err)
		}
		out, err := bufio.NewReader(c).ReadString(0)
		if err != nil {
			t.Fatal(err)
		}
		return out
	}
	g.slot <- struct{}{}
	for _, endpoint := range []struct{ network, address string }{{"unix", path}, {"tcp", tcpListener.Addr().String()}} {
		if got := scan(endpoint.network, endpoint.address, []byte("hi")); !strings.Contains(got, "busy ERROR") {
			t.Fatal(got)
		}
	}
	<-g.slot
	if got := scan("unix", path, []byte("hi")); got != "stream: OK\x00" {
		t.Fatal(got)
	}
	if got := scan("unix", path, bytes.Repeat([]byte("A"), 4097)); !strings.Contains(got, "StreamMaxLength") {
		t.Fatal(got)
	}
	if got := scan("tcp", tcpListener.Addr().String(), []byte("hi")); got != "stream: OK\x00" {
		t.Fatal(got)
	}
	cancel()
	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("listeners did not stop")
	}
	if _, err := os.Stat(path); !os.IsNotExist(err) {
		t.Fatalf("socket not removed: %v", err)
	}
}

func TestSupervisorSocketRefusesInvalidOrOccupiedPaths(t *testing.T) {
	if l, err := listenScannerSocket("relative.sock"); err == nil {
		l.Close()
		t.Fatal("relative path accepted")
	}
	file := filepath.Join(t.TempDir(), "occupied")
	if err := os.WriteFile(file, []byte("preserve"), 0600); err != nil {
		t.Fatal(err)
	}
	if l, err := listenScannerSocket(file); err == nil {
		l.Close()
		t.Fatal("occupied path replaced")
	}
	b, err := os.ReadFile(file)
	if err != nil || string(b) != "preserve" {
		t.Fatal("existing path modified")
	}
}
