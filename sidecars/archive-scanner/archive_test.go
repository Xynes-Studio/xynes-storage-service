package main

import (
	"archive/zip"
	"bytes"
	"testing"
)

func makeZIP(t *testing.T, members ...[]byte) []byte {
	t.Helper()
	var b bytes.Buffer
	z := zip.NewWriter(&b)
	for i, body := range members {
		w, e := z.Create(string(rune('a'+i)) + ".bin")
		if e != nil {
			t.Fatal(e)
		}
		if _, e = w.Write(body); e != nil {
			t.Fatal(e)
		}
	}
	if e := z.Close(); e != nil {
		t.Fatal(e)
	}
	return b.Bytes()
}
func smallPolicy() policy {
	return policy{Input: 4096, File: 1024, Expanded: 2048, Files: 4, Depth: 3, ScanMS: 100, WallMS: 200}
}
func TestArchiveLimits(t *testing.T) {
	p := smallPolicy()
	ordinary := makeZIP(t, []byte("hello harmless archive"))
	cases := []struct {
		name string
		b    []byte
		p    policy
		want string
	}{
		{"ordinary", ordinary, p, ""},
		{"individual", makeZIP(t, bytes.Repeat([]byte("A"), 1025)), p, "MaxFileSize"},
		{"expanded", makeZIP(t, bytes.Repeat([]byte("A"), 800), bytes.Repeat([]byte("B"), 800), bytes.Repeat([]byte("C"), 800)), p, "MaxScanSize"},
		{"members", makeZIP(t, []byte{}, []byte{}, []byte{}, []byte{}, []byte{}), p, "MaxFiles"},
		{"nesting", makeZIP(t, makeZIP(t, makeZIP(t, makeZIP(t, []byte("hello"))))), p, "MaxRecursion"},
		{"broken", []byte("PK\x03\x04incomplete"), p, "ArchiveIncomplete"},
		{"unsupported", []byte("7z\xbc\xaf\x27\x1crest"), p, "ArchiveUnsupported"},
		{"plain", []byte("hello harmless"), p, ""},
		{"compressed", bytes.Repeat([]byte("A"), 4097), p, "StreamMaxLength"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			if got := validateArchive(c.b, c.p); got != c.want {
				t.Fatalf("got %q want %q", got, c.want)
			}
		})
	}
}
func TestZIPIntegrity(t *testing.T) {
	b := makeZIP(t, []byte("hello harmless archive"))
	b[40] ^= 255
	if got := validateArchive(b, smallPolicy()); got != "ArchiveIncomplete" {
		t.Fatalf("corrupt ZIP accepted: %q", got)
	}
}
