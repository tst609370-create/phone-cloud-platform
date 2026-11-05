package main

import (
	"archive/zip"
	"bytes"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestPayloadRoundTripAndPathGuard(t *testing.T) {
	var buf bytes.Buffer
	zw := zip.NewWriter(&buf)
	w, err := zw.Create("app/dist/index.js")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := w.Write([]byte("console.log(1)")); err != nil {
		t.Fatal(err)
	}
	if err := zw.Close(); err != nil {
		t.Fatal(err)
	}
	packed := appendPayload([]byte("EXE"), buf.Bytes())
	reader, err := openPayload(bytes.NewReader(packed), int64(len(packed)))
	if err != nil {
		t.Fatal(err)
	}
	if len(reader.File) != 1 || reader.File[0].Name != "app/dist/index.js" {
		t.Fatalf("files = %#v", reader.File)
	}
	if _, err := openPayload(bytes.NewReader([]byte("not an installer")), int64(len("not an installer"))); err == nil {
		t.Fatal("plain file was accepted")
	}
	invite := strings.Repeat("ab", 32)
	withInvite := append(packed, []byte(invite)...)
	var lenBuf [2]byte
	lenBuf[0] = byte(len(invite))
	lenBuf[1] = 0
	withInvite = append(withInvite, lenBuf[:]...)
	withInvite = append(withInvite, []byte("PRINVITE")...)
	gotInvite, payloadSize, err := splitInvite(bytes.NewReader(withInvite), int64(len(withInvite)))
	if err != nil || gotInvite != invite || payloadSize != int64(len(packed)) {
		t.Fatalf("invite=%s size=%d err=%v", gotInvite, payloadSize, err)
	}
	publicInvite, publicSize, err := splitInvite(bytes.NewReader(packed), int64(len(packed)))
	if err != nil || publicInvite != "" || publicSize != int64(len(packed)) {
		t.Fatal(publicInvite, publicSize, err)
	}
	dir := t.TempDir()
	if _, err := safeJoin(dir, `..\Windows\System32\cmd.exe`); err == nil {
		t.Fatal("traversal was accepted")
	}
	got, err := safeJoin(dir, "app/dist/index.js")
	if err != nil {
		t.Fatal(err)
	}
	if !filepath.IsAbs(got) && os.PathSeparator == '/' {
		t.Fatal(got)
	}
}
