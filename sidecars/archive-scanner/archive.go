package main

import (
	"archive/tar"
	"archive/zip"
	"bytes"
	"compress/gzip"
	"encoding/binary"
	"io"
	"mime"

	"strings"
)

// Limits apply across the entire tree, including nested containers and empty members.
type policy struct {
	Input, File, Expanded        int64
	Files, Depth, ScanMS, WallMS int
}
type archiveBudget struct {
	p        policy
	expanded int64
	files    int
}

func validateArchive(b []byte, p policy, contentType ...string) string {
	if int64(len(b)) > p.Input {
		return "StreamMaxLength"
	}
	name := ""
	if len(contentType) > 0 && contentType[0] != "" {
		mediaType, _, err := mime.ParseMediaType(contentType[0])
		if err != nil {
			return "ArchiveIncomplete"
		}
		switch strings.ToLower(mediaType) {
		case "application/zip", "application/x-zip-compressed":
			name = "input.zip"
		case "application/gzip", "application/x-gzip":
			name = "input.gz"
		case "application/x-tar":
			name = "input.tar"
		case "application/x-7z-compressed", "application/vnd.rar", "application/x-rar-compressed", "application/x-bzip2", "application/x-xz", "application/zstd", "application/x-lzma", "application/x-cpio", "application/x-iso9660-image", "application/vnd.ms-cab-compressed", "application/x-apple-diskimage":
			return "ArchiveUnsupported"
		}
	}
	return (&archiveBudget{p: p}).inspect(b, 0, name)
}
func unsupported(b []byte, name string) bool {
	for _, magic := range [][]byte{[]byte("Rar!"), []byte("7z\xbc\xaf\x27\x1c"), []byte("BZh"), {0xfd, '7', 'z', 'X', 'Z', 0}, []byte("MSCF"), []byte("!<arch>\n"), {0x28, 0xb5, 0x2f, 0xfd}, {0x04, 0x22, 0x4d, 0x18}, {0x1f, 0x9d}, []byte("LZIP"), []byte("xar!"), []byte("070701"), []byte("070702"), []byte("070707"), {0xed, 0xab, 0xee, 0xdb}, {0x60, 0xea}, []byte("ITSF")} {
		if bytes.HasPrefix(b, magic) {
			return true
		}
	}
	if bytes.Contains(b, []byte("Rar!")) || (len(b) >= 32774 && string(b[32769:32774]) == "CD001") || (len(b) >= 512 && string(b[len(b)-512:len(b)-508]) == "koly") {
		return true
	}
	for _, ext := range []string{".rar", ".7z", ".bz2", ".xz", ".cab", ".iso", ".zst", ".lz", ".lzma"} {
		if strings.HasSuffix(strings.ToLower(name), ext) {
			return true
		}
	}
	return false
}
func (v *archiveBudget) inspect(b []byte, depth int, name string) string {
	if unsupported(b, name) {
		return "ArchiveUnsupported"
	}
	isZIP := bytes.HasPrefix(b, []byte("PK")) || bytes.Contains(b, []byte("PK\x05\x06")) || strings.HasSuffix(strings.ToLower(name), ".zip")
	isGZIP := bytes.HasPrefix(b, []byte{0x1f, 0x8b}) || strings.HasSuffix(strings.ToLower(name), ".gz") || strings.HasSuffix(strings.ToLower(name), ".tgz")
	isTAR := (len(b) >= 265 && string(b[257:262]) == "ustar") || strings.HasSuffix(strings.ToLower(name), ".tar")
	if !isZIP && !isGZIP && !isTAR && len(b) >= 512 {
		// V7 has no ustar marker. A valid first header must still be inspected.
		_, err := tar.NewReader(bytes.NewReader(b)).Next()
		isTAR = err == nil
	}
	if !isZIP && !isGZIP && !isTAR {
		return ""
	}
	if depth >= v.p.Depth {
		return "MaxRecursion"
	}
	if isZIP {
		// Reject excessive directory counts before archive/zip allocates File entries.
		end := bytes.LastIndex(b, []byte("PK\x05\x06"))
		if end < 0 || len(b)-end < 22 {
			return "ArchiveIncomplete"
		}
		count := int(binary.LittleEndian.Uint16(b[end+10 : end+12]))
		if count == 65535 {
			return "ArchiveUnsupported"
		} // ZIP64 is deliberately outside this bounded policy.
		if count > v.p.Files-v.files {
			return "MaxFiles"
		}
		if binary.LittleEndian.Uint16(b[end+4:end+6]) != 0 || binary.LittleEndian.Uint16(b[end+6:end+8]) != 0 || end+22+int(binary.LittleEndian.Uint16(b[end+20:end+22])) != len(b) {
			return "ArchiveIncomplete"
		}
		// Bound actual central records; an attacker can lie in the EOCD count.
		offset := int64(binary.LittleEndian.Uint32(b[end+16 : end+20]))
		directorySize := int64(binary.LittleEndian.Uint32(b[end+12 : end+16]))
		if offset < 0 || offset+directorySize != int64(end) {
			return "ArchiveIncomplete"
		}
		records := 0
		for cursor := offset; cursor < int64(end); {
			if int64(end)-cursor < 46 || string(b[cursor:cursor+4]) != "PK\x01\x02" {
				return "ArchiveIncomplete"
			}
			records++
			if records > v.p.Files-v.files {
				return "MaxFiles"
			}
			size := int64(46) + int64(binary.LittleEndian.Uint16(b[cursor+28:cursor+30])) + int64(binary.LittleEndian.Uint16(b[cursor+30:cursor+32])) + int64(binary.LittleEndian.Uint16(b[cursor+32:cursor+34]))
			if size > int64(end)-cursor {
				return "ArchiveIncomplete"
			}
			cursor += size
		}
		if records != count {
			return "ArchiveIncomplete"
		}
		z, err := zip.NewReader(bytes.NewReader(b), int64(len(b)))
		if err != nil || len(z.File) != count {
			return "ArchiveIncomplete"
		}
		for _, f := range z.File {
			if f.Flags&1 != 0 {
				return "ArchiveEncrypted"
			}
			if f.UncompressedSize64 > uint64(v.p.File) {
				return "MaxFileSize"
			}
			r, err := f.Open()
			if err != nil {
				return "ArchiveIncomplete"
			}
			code := v.member(r, depth+1, f.Name)
			r.Close()
			if code != "" {
				return code
			}
		}
		return ""
	}
	if isGZIP {
		r, err := gzip.NewReader(bytes.NewReader(b))
		if err != nil {
			return "ArchiveIncomplete"
		}
		defer r.Close()
		// Go's gzip reader validates CRC/length and reads every concatenated stream.
		innerName := strings.ToLower(name)
		if strings.HasSuffix(innerName, ".tgz") {
			innerName = strings.TrimSuffix(innerName, ".tgz") + ".tar"
		} else {
			innerName = strings.TrimSuffix(innerName, ".gz")
		}
		return v.member(r, depth+1, innerName)
	}
	reader := bytes.NewReader(b)
	tr := tar.NewReader(reader)
	for {
		h, err := tr.Next()
		if err == io.EOF {
			if len(bytes.Trim(readerBytes(reader), "\x00")) != 0 {
				return "ArchiveIncomplete"
			}
			return ""
		}
		if err != nil {
			return "ArchiveIncomplete"
		}
		if h.Typeflag != tar.TypeReg && h.Typeflag != tar.TypeRegA && h.Typeflag != tar.TypeDir {
			return "ArchiveUnsupported"
		}
		// archive/tar transparently unwraps GNU PAX sparse members as TypeReg.
		for key := range h.PAXRecords {
			if strings.HasPrefix(key, "GNU.sparse.") {
				return "ArchiveUnsupported"
			}
		}
		if h.Size > v.p.File {
			return "MaxFileSize"
		}
		if code := v.member(tr, depth+1, h.Name); code != "" {
			return code
		}
	}
}
func readerBytes(r *bytes.Reader) []byte { b, _ := io.ReadAll(r); return b }
func (v *archiveBudget) member(r io.Reader, depth int, name string) string {
	v.files++
	if v.files > v.p.Files {
		return "MaxFiles"
	}
	limit := min(v.p.File, v.p.Expanded-v.expanded)
	b, err := io.ReadAll(io.LimitReader(r, limit+1))
	if int64(len(b)) > limit {
		if limit == v.p.File {
			return "MaxFileSize"
		}
		return "MaxScanSize"
	}
	if err != nil {
		return "ArchiveIncomplete"
	}
	v.expanded += int64(len(b))
	return v.inspect(b, depth, name)
}
