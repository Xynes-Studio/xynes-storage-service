package main

import (
	"bytes"
	"context"
	"encoding/binary"
	"io"
	"os/exec"
	"strings"
	"testing"
	"time"
)

func receiveInput(r io.Reader, w io.Writer, max int64) string {
	_, code := receiveInputWithType(r, w, max)
	return code
}
func TestInputFraming(t *testing.T) {
	var b bytes.Buffer
	b.WriteString("zINSTREAM\x00")
	binary.Write(&b, binary.BigEndian, uint32(4))
	b.WriteString("test")
	binary.Write(&b, binary.BigEndian, uint32(0))
	framed := append([]byte(nil), b.Bytes()...)
	var out bytes.Buffer
	if code := receiveInput(&b, &out, 4); code != "" || out.String() != "test" {
		t.Fatalf("%q %q", code, out.String())
	}
	out.Reset()
	if code := receiveInput(bytes.NewReader(framed), &out, 3); code != "StreamMaxLength" {
		t.Fatal(code)
	}
	for _, bad := range []string{"zSCAN /tmp/foo\x00", "zINSTREAM\x00\x00\x00", "zINSTREAM\x00\x00\x00\x00\x05tiny"} {
		if code := receiveInput(bytes.NewBufferString(bad), io.Discard, 4); code == "" {
			t.Fatal("incomplete input accepted")
		}
	}
}
func TestDeadlineKillsAndReaps(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Millisecond)
	defer cancel()
	cmd := exec.Command("sleep", "10")
	if _, err := runBounded(ctx, cmd); err == nil {
		t.Fatal("deadline accepted")
	}
	if cmd.ProcessState == nil || !cmd.ProcessState.Exited() && cmd.ProcessState.String() == "" {
		t.Fatal("child not reaped")
	}
	if err := cmd.Process.Signal(nil); err == nil {
		t.Fatal("child still alive")
	}
}
func TestPolicyBounds(t *testing.T) {
	if _, err := loadPolicy(map[string]string{"CLAMD_CONF_MaxFiles": "0"}); err == nil {
		t.Fatal("unbounded policy accepted")
	}
	p, err := loadPolicy(map[string]string{"CLAMD_CONF_MaxFiles": "4"})
	if err != nil || p.Files != 4 {
		t.Fatalf("%v %v", p, err)
	}
	if _, err := loadPolicy(map[string]string{"CLAMD_CONF_MaxFiles": "513"}); err == nil {
		t.Fatal("larger policy accepted")
	}
}

func TestTypedInputAndInvalidCommands(t *testing.T) {
	var out bytes.Buffer
	mime, code := receiveInputWithType(bytes.NewReader(append([]byte("zXYNES application/zip\x00"), wire([]byte("hi"))...)), &out, 4)
	if mime != "application/zip" || code != "" || out.String() != "hi" {
		t.Fatalf("%s %s %s", mime, code, out.String())
	}
	for _, bad := range []string{"zXYNES bad\x00", "zXYNES application/zip injected\x00", strings.Repeat("A", 512), "zXYNES application/zip\x00zBAD\x00"} {
		if _, code := receiveInputWithType(bytes.NewBufferString(bad), io.Discard, 4); code == "" {
			t.Fatal("invalid typed command accepted")
		}
	}
}
