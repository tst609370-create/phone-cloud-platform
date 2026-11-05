//go:build windows

package main

import (
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"
)

type httpClientTimeout struct {
	timeout time.Duration
}

func (c httpClientTimeout) post(url string, body io.Reader) ([]byte, error) {
	if !strings.HasPrefix(url, "https://") {
		return nil, fmt.Errorf("注册地址必须是 HTTPS，已拒绝明文地址")
	}
	client := &http.Client{
		Timeout: c.timeout,
		CheckRedirect: func(req *http.Request, via []*http.Request) error {
			if req.URL.Scheme != "https" {
				return fmt.Errorf("注册被重定向离开 HTTPS")
			}
			if len(via) >= 3 {
				return fmt.Errorf("注册重定向过多")
			}
			return nil
		},
	}
	resp, err := client.Post(url, "application/json", body)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	raw, err := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if err != nil {
		return nil, err
	}
	if resp.StatusCode != 200 {
		return nil, fmt.Errorf("注册服务返回 %d", resp.StatusCode)
	}
	return raw, nil
}
