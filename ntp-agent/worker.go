package main

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"time"
)

const userAgent = "ntp2dns-agent/1.0"

// workerBackend gets the port list from the ntp2dns Worker and reports to it.
type workerBackend struct {
	API   string // Worker base URL, e.g. https://ddns.example.com
	Token string
	HTTP  *http.Client
}

func (w *workerBackend) Cacheable() bool { return true }

func (w *workerBackend) Ports(ctx context.Context) ([]portEntry, error) {
	var cfg struct{ Ports []portEntry }
	err := w.request(ctx, "GET", "/agent/config", nil, &cfg)
	return cfg.Ports, err
}

func (w *workerBackend) Report(ctx context.Context, batch []reportEntry) []outcome {
	out := make([]outcome, len(batch))
	var res struct {
		Results []struct {
			Port   int
			Result string
		}
	}
	if err := w.request(ctx, "POST", "/agent/report", map[string]any{"reports": batch}, &res); err != nil {
		for i := range out {
			out[i] = outcome{Result: err.Error(), Retry: true}
		}
		return out
	}
	byPort := map[int]string{}
	for _, r := range res.Results {
		byPort[r.Port] = r.Result
	}
	for i, r := range batch {
		res := byPort[r.Port]
		out[i] = outcome{Result: res, Rejected: res != "good" && res != "nochg"}
	}
	return out
}

func (w *workerBackend) request(ctx context.Context, method, path string, body any, out any) error {
	var b []byte
	if body != nil {
		b, _ = json.Marshal(body)
	}
	req, err := http.NewRequestWithContext(ctx, method, w.API+path, bytes.NewReader(b))
	if err != nil {
		return err
	}
	req.Header.Set("Authorization", "Bearer "+w.Token)
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("User-Agent", userAgent)
	res, err := w.client().Do(req)
	if err != nil {
		return err
	}
	defer res.Body.Close()
	if res.StatusCode != 200 {
		return fmt.Errorf("%s %s: HTTP %d", method, path, res.StatusCode)
	}
	return json.NewDecoder(res.Body).Decode(out)
}

func (w *workerBackend) client() *http.Client {
	if w.HTTP == nil {
		w.HTTP = &http.Client{Timeout: 15 * time.Second}
	}
	return w.HTTP
}
