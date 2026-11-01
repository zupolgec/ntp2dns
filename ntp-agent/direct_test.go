package main

import (
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
)

// fakeProvider stands in for any dyndns2 service (DynDNS, No-IP, deSEC...).
type fakeProvider struct {
	mu      sync.Mutex
	answers []string // consumed in order; the last one repeats
	calls   []*http.Request
	srv     *httptest.Server
}

func newFakeProvider(t *testing.T, answers ...string) *fakeProvider {
	f := &fakeProvider{answers: answers}
	f.srv = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		f.mu.Lock()
		defer f.mu.Unlock()
		f.calls = append(f.calls, r)
		answer := f.answers[0]
		if len(f.answers) > 1 {
			f.answers = f.answers[1:]
		}
		fmt.Fprintln(w, answer)
	}))
	t.Cleanup(f.srv.Close)
	return f
}

func (f *fakeProvider) got() []*http.Request {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]*http.Request(nil), f.calls...)
}

func writeConfig(t *testing.T, body string) string {
	path := filepath.Join(t.TempDir(), "devices.json")
	if err := os.WriteFile(path, []byte(body), 0o600); err != nil {
		t.Fatal(err)
	}
	return path
}

func startDirect(t *testing.T, config string) {
	t.Helper()
	b, err := loadDirect(writeConfig(t, config))
	if err != nil {
		t.Fatal(err)
	}
	startAgent(t, b, func(a *Agent) { a.Heartbeat = 0; a.CachePath = "" })
}

func TestUpdatesADyndns2ProviderDirectly(t *testing.T) {
	p := freePort(t)
	prov := newFakeProvider(t, "good 127.0.0.1")
	startDirect(t, fmt.Sprintf(`{"devices":[{"port":%d,"url":"%s/nic/update","hostname":"gate.example.net","username":"me","password":"s3cret"}]}`, p, prov.srv.URL))

	waitAnswer(t, p)
	eventually(t, "update", func() bool { return len(prov.got()) == 1 })
	r := prov.got()[0]
	if r.URL.Path != "/nic/update" || r.URL.Query().Get("hostname") != "gate.example.net" || r.URL.Query().Get("myip") != "127.0.0.1" {
		t.Fatalf("request %s", r.URL)
	}
	if u, pw, ok := r.BasicAuth(); !ok || u != "me" || pw != "s3cret" {
		t.Fatalf("auth %q %q %v", u, pw, ok)
	}
	if !strings.HasPrefix(r.UserAgent(), "ntp2dns-agent/") {
		t.Fatalf("user agent %q", r.UserAgent())
	}

	// Providers treat repeated updates with the same address as abuse.
	for range 5 {
		waitAnswer(t, p)
	}
	time.Sleep(200 * time.Millisecond)
	if n := len(prov.got()); n != 1 {
		t.Fatalf("%d updates, want 1", n)
	}
}

func TestFillsTheAddressIntoAURLTemplate(t *testing.T) {
	p := freePort(t)
	prov := newFakeProvider(t, "OK")
	startDirect(t, fmt.Sprintf(`{"devices":[{"port":%d,"url":"%s/update?domains=nvr&token=abc&ip={ip}"}]}`, p, prov.srv.URL))

	waitAnswer(t, p)
	eventually(t, "update", func() bool { return len(prov.got()) == 1 })
	q := prov.got()[0].URL.Query()
	if q.Get("ip") != "127.0.0.1" || q.Get("token") != "abc" || q.Has("myip") || q.Has("hostname") {
		t.Fatalf("query %v", q)
	}
}

func TestRetriesWhenTheProviderIsDown(t *testing.T) {
	p := freePort(t)
	prov := newFakeProvider(t, "911", "dnserr", "good 127.0.0.1")
	startDirect(t, fmt.Sprintf(`{"devices":[{"port":%d,"url":"%s/nic/update","hostname":"a.example.net"}]}`, p, prov.srv.URL))

	waitAnswer(t, p)
	eventually(t, "update after retries", func() bool { return len(prov.got()) == 3 })
	time.Sleep(200 * time.Millisecond)
	if n := len(prov.got()); n != 3 {
		t.Fatalf("%d calls, want 3", n)
	}
}

func TestStopsWhenTheProviderRejectsTheUpdate(t *testing.T) {
	p := freePort(t)
	prov := newFakeProvider(t, "badauth")
	startDirect(t, fmt.Sprintf(`{"devices":[{"port":%d,"url":"%s/nic/update","hostname":"a.example.net"}]}`, p, prov.srv.URL))

	waitAnswer(t, p)
	eventually(t, "update", func() bool { return len(prov.got()) == 1 })
	waitAnswer(t, p)
	time.Sleep(300 * time.Millisecond)
	if n := len(prov.got()); n != 1 {
		t.Fatalf("%d calls, want 1: a rejected update must not be retried", n)
	}
}

func TestServesSeveralDevicesWithTheirOwnProviders(t *testing.T) {
	p, q := freePort(t), freePort(t)
	a, b := newFakeProvider(t, "good"), newFakeProvider(t, "good")
	startDirect(t, fmt.Sprintf(`{"devices":[
		{"port":%d,"url":"%s/nic/update","hostname":"a.example.net"},
		{"port":%d,"url":"%s/nic/update","hostname":"b.example.org"}]}`, p, a.srv.URL, q, b.srv.URL))

	waitAnswer(t, p)
	waitAnswer(t, q)
	eventually(t, "both updates", func() bool { return len(a.got()) == 1 && len(b.got()) == 1 })
	if h := b.got()[0].URL.Query().Get("hostname"); h != "b.example.org" {
		t.Fatalf("second provider got %q", h)
	}
}

func TestRejectsBrokenConfigFiles(t *testing.T) {
	for name, body := range map[string]string{
		"not json":       `{`,
		"no devices":     `{"devices":[]}`,
		"duplicate port": `{"devices":[{"port":55123,"url":"https://x/nic/update","hostname":"a.x"},{"port":55123,"url":"https://x/nic/update","hostname":"b.x"}]}`,
		"bad port":       `{"devices":[{"port":0,"url":"https://x/nic/update","hostname":"a.x"}]}`,
		"no url":         `{"devices":[{"port":55123,"hostname":"a.x"}]}`,
		"not http":       `{"devices":[{"port":55123,"url":"ftp://x/","hostname":"a.x"}]}`,
		"no hostname":    `{"devices":[{"port":55123,"url":"https://x/nic/update"}]}`,
		"unknown field":  `{"devices":[{"port":55123,"url":"https://x/nic/update","hostname":"a.x","pasword":"typo"}]}`,
	} {
		if _, err := loadDirect(writeConfig(t, body)); err == nil {
			t.Errorf("%s: accepted", name)
		}
	}
}
