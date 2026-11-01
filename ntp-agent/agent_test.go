package main

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"sync"
	"testing"
	"time"
)

// fakeAPI stands in for the Worker's /agent endpoints.
type fakeAPI struct {
	mu        sync.Mutex
	ports     []portEntry
	reports   []reportEntry
	failNext  int
	tokenSeen string
	srv       *httptest.Server
}

func newFakeAPI(t *testing.T, ports ...portEntry) *fakeAPI {
	f := &fakeAPI{ports: ports}
	f.srv = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		f.mu.Lock()
		defer f.mu.Unlock()
		f.tokenSeen = r.Header.Get("Authorization")
		if f.tokenSeen != "Bearer test-token" {
			w.WriteHeader(401)
			return
		}
		switch r.URL.Path {
		case "/agent/config":
			json.NewEncoder(w).Encode(map[string]any{"ports": f.ports})
		case "/agent/report":
			if f.failNext > 0 {
				f.failNext--
				w.WriteHeader(500)
				return
			}
			var body struct{ Reports []reportEntry }
			json.NewDecoder(r.Body).Decode(&body)
			f.reports = append(f.reports, body.Reports...)
			results := []map[string]any{}
			for _, rep := range body.Reports {
				results = append(results, map[string]any{"port": rep.Port, "result": "good"})
			}
			json.NewEncoder(w).Encode(map[string]any{"results": results})
		default:
			w.WriteHeader(404)
		}
	}))
	t.Cleanup(f.srv.Close)
	return f
}

func (f *fakeAPI) setPorts(p ...portEntry) {
	f.mu.Lock()
	f.ports = p
	f.mu.Unlock()
}

func (f *fakeAPI) got() []reportEntry {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]reportEntry(nil), f.reports...)
}

func freePort(t *testing.T) int {
	c, err := net.ListenPacket("udp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()
	return c.LocalAddr().(*net.UDPAddr).Port
}

func worker(api string) backend { return &workerBackend{API: api, Token: "test-token"} }

func startAgent(t *testing.T, b backend, mutate ...func(*Agent)) {
	a := &Agent{
		Backend:        b,
		ListenIP:       "127.0.0.1",
		ConfigInterval: 100 * time.Millisecond,
		FlushInterval:  50 * time.Millisecond,
		Heartbeat:      time.Hour,
		CachePath:      filepath.Join(t.TempDir(), "ports.json"),
		Reply:          replyOptions{stratum: 3, refID: "LOCL"},
		Clock:          func() clockState { return clockState{synced: true} },
		RatePerSecond:  50,
		RateBurst:      50,
		Log:            slog.New(slog.NewTextHandler(io.Discard, nil)),
	}
	for _, m := range mutate {
		m(a)
	}
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() { a.Run(ctx); close(done) }()
	t.Cleanup(func() { cancel(); <-done })
}

func addr(port int) string { return fmt.Sprintf("127.0.0.1:%d", port) }

// waitAnswer probes until the port answers or the deadline passes.
func waitAnswer(t *testing.T, port int) probeResult {
	t.Helper()
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		if r, err := probe(addr(port), 200*time.Millisecond); err == nil {
			return r
		}
	}
	t.Fatalf("port %d never answered", port)
	return probeResult{}
}

func eventually(t *testing.T, what string, cond func() bool) {
	t.Helper()
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		if cond() {
			return
		}
		time.Sleep(20 * time.Millisecond)
	}
	t.Fatalf("timed out waiting for %s", what)
}

func TestAnswersTimeAndReportsTheCallerIP(t *testing.T) {
	p := freePort(t)
	api := newFakeAPI(t, portEntry{Port: p, Device: "nvr-a"})
	startAgent(t, worker(api.srv.URL))

	r := waitAnswer(t, p)
	if r.Offset.Abs() > time.Second {
		t.Fatalf("offset %v", r.Offset)
	}
	if r.Stratum != 3 {
		t.Fatalf("stratum %d", r.Stratum)
	}
	eventually(t, "report", func() bool { return len(api.got()) == 1 })
	if got := api.got()[0]; got.Port != p || got.IP != "127.0.0.1" {
		t.Fatalf("report %+v", got)
	}
}

func TestReportsOnlyWhenTheIPChanges(t *testing.T) {
	p := freePort(t)
	api := newFakeAPI(t, portEntry{Port: p, Device: "nvr-b"})
	startAgent(t, worker(api.srv.URL))

	waitAnswer(t, p)
	eventually(t, "first report", func() bool { return len(api.got()) == 1 })
	for range 5 {
		waitAnswer(t, p)
	}
	time.Sleep(200 * time.Millisecond)
	if n := len(api.got()); n != 1 {
		t.Fatalf("%d reports, want 1", n)
	}
}

func TestSendsAHeartbeatForSilentlyStableDevices(t *testing.T) {
	p := freePort(t)
	api := newFakeAPI(t, portEntry{Port: p, Device: "nvr-c"})
	startAgent(t, worker(api.srv.URL), func(a *Agent) { a.Heartbeat = 150 * time.Millisecond })

	waitAnswer(t, p)
	eventually(t, "first report", func() bool { return len(api.got()) == 1 })
	time.Sleep(250 * time.Millisecond)
	waitAnswer(t, p)
	eventually(t, "heartbeat report", func() bool { return len(api.got()) == 2 })
}

func TestFollowsPortChangesFromThePanel(t *testing.T) {
	p, q := freePort(t), freePort(t)
	api := newFakeAPI(t, portEntry{Port: p, Device: "nvr-d"})
	startAgent(t, worker(api.srv.URL))
	waitAnswer(t, p)

	api.setPorts(portEntry{Port: q, Device: "nvr-d"})
	waitAnswer(t, q)
	eventually(t, "old port closed", func() bool {
		_, err := probe(addr(p), 100*time.Millisecond)
		return err != nil
	})
}

func TestRetriesReportsWhenTheAPIFails(t *testing.T) {
	p := freePort(t)
	api := newFakeAPI(t, portEntry{Port: p, Device: "nvr-e"})
	api.failNext = 2
	startAgent(t, worker(api.srv.URL))

	waitAnswer(t, p)
	eventually(t, "report after retries", func() bool { return len(api.got()) == 1 })
}

func TestKeepsServingFromCacheWhenTheAPIIsDown(t *testing.T) {
	p := freePort(t)
	cache := filepath.Join(t.TempDir(), "ports.json")
	data, _ := json.Marshal([]portEntry{{Port: p, Device: "nvr-f"}})
	if err := os.WriteFile(cache, data, 0o600); err != nil {
		t.Fatal(err)
	}
	startAgent(t, worker("http://127.0.0.1:1"), func(a *Agent) { a.CachePath = cache })
	waitAnswer(t, p)
}

func TestWritesTheCacheAfterLoadingConfig(t *testing.T) {
	p := freePort(t)
	api := newFakeAPI(t, portEntry{Port: p, Device: "nvr-g"})
	cache := filepath.Join(t.TempDir(), "ports.json")
	startAgent(t, worker(api.srv.URL), func(a *Agent) { a.CachePath = cache })
	waitAnswer(t, p)
	eventually(t, "cache file", func() bool {
		var got []portEntry
		b, err := os.ReadFile(cache)
		return err == nil && json.Unmarshal(b, &got) == nil && len(got) == 1 && got[0].Port == p
	})
}

func TestRateLimitsFloods(t *testing.T) {
	p := freePort(t)
	api := newFakeAPI(t, portEntry{Port: p, Device: "nvr-h"})
	startAgent(t, worker(api.srv.URL), func(a *Agent) { a.RatePerSecond = 1; a.RateBurst = 3 })
	waitAnswer(t, p) // uses up part of the burst

	answered := 0
	for range 20 {
		if _, err := probe(addr(p), 50*time.Millisecond); err == nil {
			answered++
		}
	}
	if answered > 4 {
		t.Fatalf("%d answers to a flood, want at most 4", answered)
	}
}
