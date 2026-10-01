package main

import (
	"bufio"
	"bytes"
	"context"
	"encoding/binary"
	"errors"
	"fmt"
	"io"
	"net"
	"os"
	"os/exec"
	"os/signal"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"
)

const inputTimeout = 10 * time.Second

func readCommand(r *bufio.Reader) (string, error) {
	var b bytes.Buffer
	for b.Len() < 512 {
		v, err := r.ReadByte()
		if err != nil {
			return "", err
		}
		if v == 0 {
			return b.String(), nil
		}
		b.WriteByte(v)
	}
	return "", errors.New("invalid scanner command")
}
func receiveInputWithType(r io.Reader, w io.Writer, max int64) (string, string) {
	br := bufio.NewReader(r)
	command, err := readCommand(br)
	mime := ""
	if err != nil {
		return "", "ArchiveIncomplete"
	}
	if strings.HasPrefix(command, "zXYNES ") {
		mime = strings.TrimPrefix(command, "zXYNES ")
		if len(mime) > 255 || !strings.Contains(mime, "/") || strings.ContainsAny(mime, "\r\n\t ") {
			return "", "ArchiveIncomplete"
		}
		command, err = readCommand(br)
		if err != nil {
			return "", "ArchiveIncomplete"
		}
	}
	if command != "zINSTREAM" {
		return "", "ArchiveIncomplete"
	}
	var total int64
	for {
		var n uint32
		if binary.Read(br, binary.BigEndian, &n) != nil {
			return "", "ArchiveIncomplete"
		}
		if n == 0 {
			return mime, ""
		}
		if int64(n) > max-total {
			return "", "StreamMaxLength"
		}
		if _, err := io.CopyN(w, br, int64(n)); err != nil {
			return "", "ArchiveIncomplete"
		}
		total += int64(n)
	}
}

// Both children are single processes. Kill then Wait before reporting a timeout.
func runBounded(ctx context.Context, cmd *exec.Cmd) ([]byte, error) {
	var out bytes.Buffer
	cmd.Stdout = &out
	cmd.Stderr = io.Discard
	if err := cmd.Start(); err != nil {
		return nil, err
	}
	done := make(chan error, 1)
	go func() { done <- cmd.Wait() }()
	select {
	case err := <-done:
		return out.Bytes(), err
	case <-ctx.Done():
		_ = cmd.Process.Kill()
		<-done
		return nil, ctx.Err()
	}
}
func loadPolicy(env map[string]string) (policy, error) {
	for _, name := range []string{"ScanArchive", "AlertExceedsMax", "AlertEncrypted"} {
		if raw := env["CLAMD_CONF_"+name]; raw != "" && raw != "yes" {
			return policy{}, errors.New("unsafe scanner configuration")
		}
	}
	p := policy{Input: 64 << 20, File: 64 << 20, Expanded: 128 << 20, Files: 512, Depth: 5, ScanMS: 5000, WallMS: 10000}
	values := []struct {
		key string
		max int64
		set func(int64)
	}{
		{"StreamMaxLength", p.Input, func(n int64) { p.Input = n }}, {"MaxFileSize", p.File, func(n int64) { p.File = n }}, {"MaxScanSize", p.Expanded, func(n int64) { p.Expanded = n }}, {"MaxFiles", int64(p.Files), func(n int64) { p.Files = int(n) }}, {"MaxRecursion", int64(p.Depth), func(n int64) { p.Depth = int(n) }}, {"MaxScanTime", int64(p.ScanMS), func(n int64) { p.ScanMS = int(n) }}, {"WallTime", int64(p.WallMS), func(n int64) { p.WallMS = int(n) }},
	}
	for _, v := range values {
		raw := env["CLAMD_CONF_"+v.key]
		if raw == "" {
			continue
		}
		n, err := strconv.ParseInt(raw, 10, 64)
		if err != nil || n <= 0 || n > v.max {
			return policy{}, errors.New("invalid scanner policy")
		}
		v.set(n)
	}
	if p.Input > p.File || p.File > p.Expanded || p.ScanMS >= p.WallMS {
		return policy{}, errors.New("incompatible scanner policy")
	}
	return p, nil
}
func (p policy) config(database string) string {
	return fmt.Sprintf("Foreground yes\nTCPSocket 3311\nTCPAddr 127.0.0.1\nLocalSocket /tmp/clamd.sock\nDatabaseDirectory %s\nTemporaryDirectory /tmp\nScanArchive yes\nAlertExceedsMax yes\nAlertEncrypted yes\nAlertBrokenExecutables yes\nAlertBrokenMedia yes\nMaxFileSize %d\nMaxScanSize %d\nMaxFiles %d\nMaxRecursion %d\nMaxScanTime %d\nStreamMaxLength %d\nMaxThreads 1\nMaxQueue 2\nCommandReadTimeout 5\nReadTimeout 10\nBytecodeTimeout 1000\nConcurrentDatabaseReload no\n", database, p.File, p.Expanded, p.Files, p.Depth, p.ScanMS, p.Input)
}

type daemon struct {
	command        func() *exec.Cmd
	startupTimeout time.Duration
	pollInterval   time.Duration

	config string
	cmd    *exec.Cmd
	done   chan error
	dial   func() (net.Conn, error)
}

func (d *daemon) start() error {
	if d.command != nil {
		d.cmd = d.command()
	} else {
		d.cmd = exec.Command("clamd", "--config-file="+d.config)
	}
	d.cmd.Stdout = io.Discard
	d.cmd.Stderr = io.Discard
	if err := d.cmd.Start(); err != nil {
		d.cmd = nil
		d.done = nil
		return err
	}
	d.done = make(chan error, 1)
	cmd, done := d.cmd, d.done
	go func() { done <- cmd.Wait() }()
	startupTimeout := d.startupTimeout
	if startupTimeout == 0 {
		startupTimeout = 120 * time.Second
	}
	pollInterval := d.pollInterval
	if pollInterval == 0 {
		pollInterval = 100 * time.Millisecond
	}
	deadline := time.Now().Add(startupTimeout)
	for time.Now().Before(deadline) {
		select {
		case <-d.done:
			d.cmd = nil
			return errors.New("scanner unavailable")
		default:
		}
		c, err := d.dial()
		if err == nil {
			c.SetDeadline(time.Now().Add(time.Second))
			_, err = c.Write([]byte("zPING\x00"))
			reply := make([]byte, 5)
			_, readErr := io.ReadFull(c, reply)
			c.Close()
			if err == nil && readErr == nil && string(reply) == "PONG\x00" {
				return nil
			}
		}
		time.Sleep(pollInterval)
	}
	d.stop()
	return errors.New("scanner startup timeout")
}
func (d *daemon) stop() {
	if d.cmd == nil {
		return
	}
	_ = d.cmd.Process.Kill()
	<-d.done
	d.cmd = nil
}
func (d *daemon) scan(ctx context.Context, b []byte) (string, error) {
	c, err := d.dial()
	if err != nil {
		return "", err
	}
	defer c.Close()
	stopCancellation := context.AfterFunc(ctx, func() { c.Close() })
	defer stopCancellation()
	deadline, _ := ctx.Deadline()
	c.SetDeadline(deadline)
	if _, err = c.Write([]byte("zINSTREAM\x00")); err != nil {
		return "", err
	}
	for offset := 0; offset < len(b); {
		n := min(64<<10, len(b)-offset)
		var length [4]byte
		binary.BigEndian.PutUint32(length[:], uint32(n))
		if _, err = c.Write(length[:]); err != nil {
			return "", err
		}
		if _, err = c.Write(b[offset : offset+n]); err != nil {
			return "", err
		}
		offset += n
	}
	if _, err = c.Write([]byte{0, 0, 0, 0}); err != nil {
		return "", err
	}
	var reply bytes.Buffer
	var one [1]byte
	for reply.Len() < 4096 {
		if _, err = io.ReadFull(c, one[:]); err != nil {
			return "", err
		}
		if one[0] == 0 {
			return reply.String(), nil
		}
		reply.WriteByte(one[0])
	}
	return "", errors.New("scanner incomplete response")
}

type gateway struct {
	p       policy
	daemon  *daemon
	slot    chan struct{}
	self    string
	onFatal func()
	baseCtx context.Context
}

func (g *gateway) handle(c net.Conn) {
	defer c.Close()
	select {
	case g.slot <- struct{}{}:
		defer func() { <-g.slot }()
	default:
		reply(c, "stream: scanner busy ERROR")
		return
	}
	baseCtx := g.baseCtx
	if baseCtx == nil {
		baseCtx = context.Background()
	}
	cancelConnection := context.AfterFunc(baseCtx, func() { c.Close() })
	defer cancelConnection()
	c.SetDeadline(time.Now().Add(inputTimeout))
	f, err := os.CreateTemp("/tmp", "xynes-scan-*")
	if err != nil {
		reply(c, "stream: scanner unavailable ERROR")
		return
	}
	path := f.Name()
	defer os.Remove(path)
	mime, code := receiveInputWithType(c, f, g.p.Input)
	f.Close()
	if code != "" {
		replyLimit(c, code)
		return
	}
	c.SetDeadline(time.Now().Add(time.Duration(g.p.WallMS)*time.Millisecond + time.Second))
	ctx, cancel := context.WithTimeout(baseCtx, time.Duration(g.p.WallMS)*time.Millisecond)
	defer cancel()
	// Validation is a separate killable process; no extraction happens in Storage.
	out, err := runBounded(ctx, exec.Command(g.self, "validate", path, mime))
	if err != nil {
		if ctx.Err() != nil {
			replyLimit(c, "MaxScanTime")
		} else {
			reply(c, "stream: scanner unavailable ERROR")
		}
		return
	}
	if code = strings.TrimSpace(string(out)); code != "" {
		replyLimit(c, code)
		return
	}
	b, err := os.ReadFile(path)
	if err != nil {
		reply(c, "stream: scanner unavailable ERROR")
		return
	}
	result, err := g.daemon.scan(ctx, b)
	if err != nil {
		// Socket failure never proves daemon completion. Reap the owned daemon first.
		g.daemon.stop()
		fmt.Fprintln(os.Stderr, "scanner watchdog reaped daemon")
		replyLimit(c, "MaxScanTime")
		// Keep the slot during bounded restart; all concurrent requests fail closed.
		if baseCtx.Err() != nil {
			return
		}
		if g.daemon.start() != nil && g.onFatal != nil {
			g.onFatal()
		}
		return
	}
	reply(c, result)
}
func reply(c net.Conn, s string)         { _, _ = io.WriteString(c, s+"\x00") }
func replyLimit(c net.Conn, code string) { reply(c, "stream: Xynes.Archive.Limit."+code+" FOUND") }
func environment() map[string]string {
	m := map[string]string{}
	for _, v := range os.Environ() {
		k, val, ok := strings.Cut(v, "=")
		if ok {
			m[k] = val
		}
	}
	return m
}
func main() {
	p, err := loadPolicy(environment())
	if err != nil {
		fmt.Fprintln(os.Stderr, "invalid scanner policy")
		os.Exit(1)
	}
	if (len(os.Args) == 3 || len(os.Args) == 4) && os.Args[1] == "validate" {
		b, err := os.ReadFile(os.Args[2])
		if err != nil {
			os.Exit(1)
		}
		mime := ""
		if len(os.Args) == 4 {
			mime = os.Args[3]
		}
		fmt.Print(validateArchive(b, p, mime))
		return
	}
	database := os.Getenv("XYNES_SCANNER_DATABASE")
	if database == "" {
		database = "/var/lib/clamav"
	}
	config := "/tmp/clamd.conf"
	if os.WriteFile(config, []byte(p.config(database)), 0600) != nil {
		os.Exit(1)
	}
	d := &daemon{config: config, dial: func() (net.Conn, error) { return net.DialTimeout("tcp", "127.0.0.1:3311", time.Second) }}
	if d.start() != nil {
		fmt.Fprintln(os.Stderr, "scanner startup failed")
		os.Exit(1)
	}
	defer d.stop()
	self, err := os.Executable()
	if err != nil {
		os.Exit(1)
	}
	listener, err := net.Listen("tcp", ":3310")
	if err != nil {
		os.Exit(1)
	}
	defer listener.Close()
	ctx, stopSignals := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stopSignals()
	g := &gateway{p: p, daemon: d, slot: make(chan struct{}, 1), self: self}
	serve(ctx, listener, g)
}

func serve(ctx context.Context, listener net.Listener, g *gateway) {
	ctx, cancel := context.WithCancel(ctx)
	defer cancel()
	g.baseCtx = ctx
	g.onFatal = cancel
	go func() { <-ctx.Done(); listener.Close() }()
	var active sync.WaitGroup
	defer active.Wait()
	for {
		c, err := listener.Accept()
		if err != nil {
			cancel()
			return
		}
		active.Add(1)
		go func() { defer active.Done(); g.handle(c) }()
	}
}
