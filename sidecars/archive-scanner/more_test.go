package main

import (
	"archive/tar"
	"archive/zip"
	"bytes"
	"compress/gzip"
	"encoding/binary"
	"fmt"
	"io"
	"testing"
)

func gz(t *testing.T, b []byte) []byte {
	t.Helper()
	var out bytes.Buffer
	z := gzip.NewWriter(&out)
	z.Write(b)
	z.Close()
	return out.Bytes()
}
func tarBytes(t *testing.T, kind byte, body []byte) []byte {
	t.Helper()
	var out bytes.Buffer
	z := tar.NewWriter(&out)
	z.WriteHeader(&tar.Header{Name: "member", Mode: 0600, Size: int64(len(body)), Typeflag: kind})
	z.Write(body)
	z.Close()
	return out.Bytes()
}
func TestGzipAndTar(t *testing.T) {
	p := smallPolicy()
	for _, b := range [][]byte{gz(t, []byte("hello benign")), tarBytes(t, tar.TypeReg, []byte("hello")), gz(t, tarBytes(t, tar.TypeReg, []byte("hello")))} {
		ordinaryPolicy := p
		ordinaryPolicy.File = 4096
		ordinaryPolicy.Expanded = 8192
		if c := validateArchive(b, ordinaryPolicy); c != "" {
			t.Fatal(c)
		}
	}
	for _, tc := range []struct {
		b    []byte
		code string
	}{
		{gz(t, bytes.Repeat([]byte("A"), 1025)), "MaxFileSize"},
		{tarBytes(t, tar.TypeReg, bytes.Repeat([]byte("A"), 1025)), "MaxFileSize"},
		{tarBytes(t, tar.TypeSymlink, nil), "ArchiveUnsupported"},
		{[]byte{0x1f, 0x8b, 0}, "ArchiveIncomplete"},
	} {
		if c := validateArchive(tc.b, p); c != tc.code {
			t.Fatalf("%s want %s", c, tc.code)
		}
	}
	b := gz(t, []byte("hello harmless"))
	b[len(b)-5] ^= 255
	if c := validateArchive(b, p); c != "ArchiveIncomplete" {
		t.Fatal(c)
	}
}
func TestZIPMetadata(t *testing.T) {
	p := smallPolicy()
	original := makeZIP(t, []byte("hello"))
	for _, change := range []func([]byte){
		func(b []byte) {
			binary.LittleEndian.PutUint16(b[6:8], 1)
			i := bytes.Index(b, []byte("PK\x01\x02"))
			binary.LittleEndian.PutUint16(b[i+8:i+10], 1)
		},
		func(b []byte) {
			i := bytes.LastIndex(b, []byte("PK\x05\x06"))
			binary.LittleEndian.PutUint16(b[i+10:i+12], 65535)
		},
		func(b []byte) {
			i := bytes.LastIndex(b, []byte("PK\x05\x06"))
			binary.LittleEndian.PutUint16(b[i+4:i+6], 1)
		},
		func(b []byte) {
			i := bytes.Index(b, []byte("PK\x01\x02"))
			binary.LittleEndian.PutUint16(b[i+10:i+12], 99)
		},
	} {
		b := append([]byte(nil), original...)
		change(b)
		if c := validateArchive(b, p); c == "" {
			t.Fatal("invalid metadata accepted")
		}
	}
	// Declared length is not trusted: inflated bytes and CRC must also match.
	b := append([]byte(nil), original...)
	i := bytes.Index(b, []byte("PK\x01\x02"))
	binary.LittleEndian.PutUint32(b[i+24:i+28], 1)
	if c := validateArchive(b, p); c != "ArchiveIncomplete" {
		t.Fatal(c)
	}
	v := archiveBudget{p: p, files: 4}
	if c := v.member(bytes.NewBufferString("a"), 1, ""); c != "MaxFiles" {
		t.Fatal(c)
	}
	if c := (&archiveBudget{p: p}).inspect([]byte("bad"), 0, "member.zip"); c != "ArchiveIncomplete" {
		t.Fatal(c)
	}
	if c := (&archiveBudget{p: p}).inspect([]byte("bad"), 0, "member.rar"); c != "ArchiveUnsupported" {
		t.Fatal(c)
	}
	if c := (&archiveBudget{p: p}).inspect([]byte("bad"), 0, "member.tar"); c != "ArchiveIncomplete" {
		t.Fatal(c)
	}
	if c := validateArchive(append(tarBytes(t, tar.TypeReg, []byte("hello")), []byte("garbage")...), p); c != "ArchiveIncomplete" {
		t.Fatal(c)
	}
	if c := (&archiveBudget{p: p}).member(io.LimitReader(bytes.NewBufferString("a"), 1), 1, ""); c != "" {
		t.Fatal(c)
	}
}

func TestForgedDirectoryCountIsBoundedBeforeZIPAllocation(t *testing.T) {
	p := smallPolicy()
	b := makeZIP(t, []byte{}, []byte{}, []byte{}, []byte{}, []byte{}, []byte{})
	end := bytes.LastIndex(b, []byte("PK\x05\x06"))
	binary.LittleEndian.PutUint16(b[end+8:end+10], 1)
	binary.LittleEndian.PutUint16(b[end+10:end+12], 1)
	if code := validateArchive(b, p); code != "MaxFiles" {
		t.Fatalf("actual directory count must be bounded before allocation: %s", code)
	}
}

func TestLegacyTARAndNestedGzipNames(t *testing.T) {
	p := smallPolicy()
	b := tarBytes(t, tar.TypeReg, bytes.Repeat([]byte("A"), 1025))
	for i := 257; i < 265; i++ {
		b[i] = 0
	}
	for i := 148; i < 156; i++ {
		b[i] = ' '
	}
	sum := 0
	for _, v := range b[:512] {
		sum += int(v)
	}
	copy(b[148:156], []byte(fmt.Sprintf("%06o\x00 ", sum)))
	if c := validateArchive(b, p); c != "MaxFileSize" {
		t.Fatalf("legacy TAR bypass %s", c)
	}
	p.File = 4096
	p.Expanded = 8192
	for _, name := range []string{"backup.tgz", "backup.GZ"} {
		inner := []byte("hello benign")
		if name == "backup.tgz" {
			inner = tarBytes(t, tar.TypeReg, inner)
		}
		var out bytes.Buffer
		z := zip.NewWriter(&out)
		w, _ := z.Create(name)
		w.Write(gz(t, inner))
		z.Close()
		if c := validateArchive(out.Bytes(), p); c != "" {
			t.Fatalf("%s %s", name, c)
		}
	}
	if c := validateArchive([]byte{0x28, 0xb5, 0x2f, 0xfd, 0}, p); c != "ArchiveUnsupported" {
		t.Fatal(c)
	}
	iso := make([]byte, 32774)
	copy(iso[32769:], "CD001")
	p.Input = 65536
	if c := validateArchive(iso, p); c != "ArchiveUnsupported" {
		t.Fatal(c)
	}
}

func TestDeclaredArchiveTypeMustBeCompletelyInspected(t *testing.T) {
	p := smallPolicy()
	for _, mime := range []string{"application/zip", "application/gzip", "application/x-tar", "application/zip;charset=utf-8", "APPLICATION/GZIP;x=1", "invalid;="} {
		if c := validateArchive([]byte("incomplete"), p, mime); c != "ArchiveIncomplete" {
			t.Fatalf("%s bypass: %s", mime, c)
		}
	}
	if c := validateArchive([]byte("unknown ISO bytes"), p, "application/x-iso9660-image"); c != "ArchiveUnsupported" {
		t.Fatal(c)
	}
	if c := validateArchive(makeZIP(t, []byte("hello")), p, "application/zip"); c != "" {
		t.Fatal(c)
	}
}

func TestPAXSparseTARRejected(t *testing.T) {
	// Two logical bytes, only one stored byte: no resource-heavy sparse payload.
	records := ""
	for _, kv := range []string{"GNU.sparse.major=0", "GNU.sparse.minor=1", "GNU.sparse.size=2", "GNU.sparse.numblocks=1", "GNU.sparse.map=0,1"} {
		n := len(kv) + 3
		for {
			record := fmt.Sprintf("%d %s\n", n, kv)
			if len(record) == n {
				records += record
				break
			}
			n = len(record)
		}
	}
	pax := tarBytes(t, tar.TypeReg, []byte(records))
	pax[156] = tar.TypeXHeader
	for i := 148; i < 156; i++ {
		pax[i] = ' '
	}
	checksum := 0
	for _, b := range pax[:512] {
		checksum += int(b)
	}
	copy(pax[148:156], []byte(fmt.Sprintf("%06o\x00 ", checksum)))
	data := append(pax[:1024], tarBytes(t, tar.TypeReg, []byte("A"))...)
	header, err := tar.NewReader(bytes.NewReader(data)).Next()
	if err != nil || header.Size != 2 || header.Typeflag != tar.TypeReg {
		t.Fatalf("invalid harmless sparse fixture: %v %v", header, err)
	}
	p := smallPolicy()
	p.Input = 16384
	p.File = 4096
	p.Expanded = 8192
	if got := validateArchive(data, p); got != "ArchiveUnsupported" {
		t.Fatalf("sparse TAR accepted: %q", got)
	}
}
