package main

import (
	"archive/zip"
	"bytes"
	"encoding/binary"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
)

var payloadMagic = []byte("PRSETUP1")
var inviteMagic = []byte("PRINVITE")

func appendPayload(exe, zipBytes []byte) []byte {
	out := make([]byte, 0, len(exe)+len(zipBytes)+16)
	out = append(out, exe...)
	out = append(out, zipBytes...)
	var tail [16]byte
	binary.LittleEndian.PutUint64(tail[:8], uint64(len(zipBytes)))
	copy(tail[8:], payloadMagic)
	out = append(out, tail[:]...)
	return out
}

// splitInvite separates a private one-time invite trailer from the public payload.
// A public base exe has no trailer and returns an empty invite.
func splitInvite(r io.ReaderAt, size int64) (string, int64, error) {
	if size < 10 {
		return "", size, nil
	}
	tail := make([]byte, 10)
	if _, err := r.ReadAt(tail, size-10); err != nil {
		return "", 0, err
	}
	if !bytes.Equal(tail[2:], inviteMagic) {
		return "", size, nil
	}
	n := int(binary.LittleEndian.Uint16(tail[:2]))
	if n < 64 || n > 256 || int64(n)+10 > size {
		return "", 0, fmt.Errorf("邀请损坏")
	}
	buf := make([]byte, n)
	if _, err := r.ReadAt(buf, size-10-int64(n)); err != nil {
		return "", 0, err
	}
	invite := string(buf)
	for _, c := range invite {
		if (c < '0' || c > '9') && (c < 'a' || c > 'f') {
			return "", 0, fmt.Errorf("邀请损坏")
		}
	}
	return invite, size - 10 - int64(n), nil
}

func openPayload(r io.ReaderAt, size int64) (*zip.Reader, error) {
	if size < 16 {
		return nil, fmt.Errorf("安装包不完整：文件太小")
	}
	var tail [16]byte
	if _, err := r.ReadAt(tail[:], size-16); err != nil {
		return nil, fmt.Errorf("读取安装包尾部失败：%w", err)
	}
	if !bytes.Equal(tail[8:], payloadMagic) {
		return nil, fmt.Errorf("这不是带安装内容的 PhoneRemote 安装包（缺少包尾标记）")
	}
	zipLen := int64(binary.LittleEndian.Uint64(tail[:8]))
	if zipLen <= 0 || zipLen > size-16 {
		return nil, fmt.Errorf("安装包内容长度无效")
	}
	return zip.NewReader(io.NewSectionReader(r, size-16-zipLen, zipLen), zipLen)
}

func safeJoin(root, name string) (string, error) {
	clean := filepath.Clean(strings.ReplaceAll(name, "\\", "/"))
	if clean == "." || clean == "" {
		return "", fmt.Errorf("空路径")
	}
	if filepath.IsAbs(clean) || clean == ".." || strings.HasPrefix(clean, ".."+string(os.PathSeparator)) || strings.HasPrefix(clean, "../") {
		return "", fmt.Errorf("拒绝路径 %s", name)
	}
	dest := filepath.Join(root, filepath.FromSlash(clean))
	rel, err := filepath.Rel(root, dest)
	if err != nil || rel == ".." || strings.HasPrefix(rel, ".."+string(os.PathSeparator)) {
		return "", fmt.Errorf("路径越界 %s", name)
	}
	return dest, nil
}
