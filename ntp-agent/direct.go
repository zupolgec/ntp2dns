package main

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"strings"
	"time"
)

// directBackend serves the ports listed in a config file and sends each new
// address straight to the device's own dynamic DNS provider, with no Worker.
type directBackend struct {
	ports   []portEntry
	devices map[int]directDevice
	HTTP    *http.Client
	Pause   time.Duration // wait after "try later" answers (911, dnserr, unknown)
}

type directDevice struct {
	Port     int    `json:"port"`
	Name     string `json:"name"`     // for logs; default: hostname
	URL      string `json:"url"`      // dyndns2 update URL, or a URL with {ip} in it
	Hostname string `json:"hostname"` // dyndns2 hostname parameter
	Username string `json:"username"` // HTTP basic auth, optional
	Password string `json:"password"`
}

func loadDirect(path string) (*directBackend, error) {
	raw, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	var cfg struct{ Devices []directDevice }
	dec := json.NewDecoder(bytes.NewReader(raw))
	dec.DisallowUnknownFields()
	if err := dec.Decode(&cfg); err != nil {
		return nil, fmt.Errorf("%s: %w", path, err)
	}
	if len(cfg.Devices) == 0 {
		return nil, fmt.Errorf("%s: no devices", path)
	}
	b := &directBackend{devices: map[int]directDevice{}, HTTP: &http.Client{Timeout: 15 * time.Second}, Pause: 30 * time.Minute}
	for i, d := range cfg.Devices {
		where := fmt.Sprintf("%s: device %d", path, i+1)
		if d.Port < 1 || d.Port > 65535 {
			return nil, fmt.Errorf("%s: port must be 1-65535", where)
		}
		if _, dup := b.devices[d.Port]; dup {
			return nil, fmt.Errorf("%s: port %d is used twice", where, d.Port)
		}
		u, err := url.Parse(d.URL)
		if err != nil || (u.Scheme != "https" && u.Scheme != "http") || u.Host == "" {
			return nil, fmt.Errorf("%s: url must be an http(s) address", where)
		}
		template := strings.Contains(d.URL, "{ip}")
		if !template && d.Hostname == "" {
			return nil, fmt.Errorf("%s: hostname is required unless the url contains {ip}", where)
		}
		if d.Name == "" {
			d.Name = d.Hostname
		}
		if d.Name == "" {
			d.Name = u.Host
		}
		b.devices[d.Port] = d
		b.ports = append(b.ports, portEntry{Port: d.Port, Device: d.Name})
	}
	return b, nil
}

func (b *directBackend) Cacheable() bool { return false }

func (b *directBackend) Ports(context.Context) ([]portEntry, error) { return b.ports, nil }

func (b *directBackend) Report(ctx context.Context, batch []reportEntry) []outcome {
	out := make([]outcome, len(batch))
	for i, r := range batch {
		d, ok := b.devices[r.Port]
		if !ok {
			out[i] = outcome{Result: "unknown port", Rejected: true}
			continue
		}
		out[i] = b.update(ctx, d, r.IP)
	}
	return out
}

// Answers that mean the provider will keep refusing until someone changes the
// configuration: sending them again would only get the account blocked.
var rejected = map[string]bool{
	"badauth": true, "nohost": true, "notfqdn": true, "numhost": true, "abuse": true,
	"badagent": true, "badsys": true, "!donator": true, "!yours": true, "ko": true,
}

func (b *directBackend) update(ctx context.Context, d directDevice, ip string) outcome {
	target := d.URL
	if strings.Contains(target, "{ip}") {
		target = strings.ReplaceAll(target, "{ip}", url.QueryEscape(ip))
	} else {
		u, _ := url.Parse(target)
		q := u.Query()
		q.Set("hostname", d.Hostname)
		q.Set("myip", ip)
		u.RawQuery = q.Encode()
		target = u.String()
	}
	req, err := http.NewRequestWithContext(ctx, "GET", target, nil)
	if err != nil {
		return outcome{Result: err.Error(), Rejected: true}
	}
	if d.Username != "" || d.Password != "" {
		req.SetBasicAuth(d.Username, d.Password)
	}
	req.Header.Set("User-Agent", userAgent)
	res, err := b.HTTP.Do(req)
	if err != nil {
		var uerr *url.Error
		if errors.As(err, &uerr) {
			err = uerr.Err // the URL may hold a token
		}
		return outcome{Result: err.Error(), Retry: true}
	}
	defer res.Body.Close()
	line, _ := bufio.NewReader(io.LimitReader(res.Body, 512)).ReadString('\n')
	line = strings.TrimSpace(line)
	word := ""
	if f := strings.Fields(line); len(f) > 0 {
		word = strings.ToLower(f[0])
	}
	status := strings.TrimSpace(fmt.Sprintf("HTTP %d %s", res.StatusCode, line))

	switch {
	case word == "911" || word == "dnserr":
		return outcome{Result: status, Retry: true, RetryAfter: b.Pause}
	case res.StatusCode == 429 || res.StatusCode >= 500:
		return outcome{Result: status, Retry: true}
	case res.StatusCode == 401 || res.StatusCode == 403:
		return outcome{Result: "badauth", Rejected: true}
	case res.StatusCode >= 400 || rejected[word]:
		return outcome{Result: status, Rejected: true}
	case strings.Contains(d.URL, "{ip}") || word == "good" || word == "nochg":
		return outcome{Result: line}
	}
	// Not a dyndns2 answer (an error page, a captive portal...): try again later.
	return outcome{Result: "unexpected answer: " + truncate(status, 80), Retry: true, RetryAfter: b.Pause}
}

func truncate(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return s[:n] + "..."
}
