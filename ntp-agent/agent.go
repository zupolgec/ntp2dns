package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"net"
	"os"
	"path/filepath"
	"slices"
	"strconv"
	"strings"
	"sync"
	"time"
)

type portEntry struct {
	Port   int    `json:"port"`
	Device string `json:"device"`
}

type reportEntry struct {
	Port int    `json:"port"`
	IP   string `json:"ip"`
}

// backend knows which ports to serve and where to send the addresses seen on
// them: the ntp2dns Worker, or any dyndns2 provider listed in a config file.
type backend interface {
	Ports(ctx context.Context) ([]portEntry, error)
	// Report returns one outcome per entry, in order.
	Report(ctx context.Context, batch []reportEntry) []outcome
	// Cacheable: the port list can change remotely, so keep a copy on disk.
	Cacheable() bool
}

type outcome struct {
	Result   string
	Retry    bool // temporary failure: send the same report again later
	Rejected bool // refused for good: not sent again until the address changes
}

// Agent answers NTP requests on one UDP port per device and reports the
// address each device is calling from to its backend.
type Agent struct {
	Backend        backend
	ListenIP       string // empty: all addresses
	ConfigInterval time.Duration
	FlushInterval  time.Duration
	Heartbeat      time.Duration // re-report an unchanged IP this often, so the panel sees the device alive; 0: never
	CachePath      string        // last known port list, used when the Worker is unreachable at start
	Reply          replyOptions
	Clock          func() clockState
	RatePerSecond  float64 // per source IP
	RateBurst      float64
	Log            *slog.Logger

	mu        sync.Mutex
	listeners map[int]*listener
	reported  map[int]reportState
	pending   map[int]string
	buckets   map[string]*bucket
	wg        sync.WaitGroup
}

type listener struct {
	conn   net.PacketConn
	device string
}

type reportState struct {
	ip string
	at time.Time
}

type bucket struct {
	tokens float64
	last   time.Time
}

func (a *Agent) Run(ctx context.Context) error {
	a.listeners = map[int]*listener{}
	a.reported = map[int]reportState{}
	a.pending = map[int]string{}
	a.buckets = map[string]*bucket{}

	if a.Backend.Cacheable() {
		if ports, err := a.readCache(); err == nil {
			a.apply(ports)
		}
	}
	a.refreshConfig(ctx)

	configTick := time.NewTicker(a.ConfigInterval)
	flushTick := time.NewTicker(a.FlushInterval)
	defer configTick.Stop()
	defer flushTick.Stop()
	backoff, nextFlush := time.Duration(0), time.Time{}

	for {
		select {
		case <-ctx.Done():
			a.apply(nil)
			a.wg.Wait()
			return nil
		case <-configTick.C:
			a.refreshConfig(ctx)
			a.pruneBuckets()
		case <-flushTick.C:
			if time.Now().Before(nextFlush) {
				continue
			}
			if err := a.flush(ctx); err != nil {
				backoff = min(max(backoff*2, a.FlushInterval), time.Minute)
				nextFlush = time.Now().Add(backoff)
				a.Log.Warn("report failed, will retry", "err", err, "in", backoff)
			} else {
				backoff = 0
			}
		}
	}
}

func (a *Agent) refreshConfig(ctx context.Context) {
	ports, err := a.Backend.Ports(ctx)
	if err != nil {
		if ctx.Err() == nil {
			a.Log.Warn("cannot load port list, keeping the current one", "err", err)
		}
		return
	}
	a.apply(ports)
	if !a.Backend.Cacheable() {
		return
	}
	if err := a.writeCache(ports); err != nil {
		a.Log.Warn("cannot write cache", "err", err)
	}
}

// apply opens listeners for new ports and closes the ones no longer listed.
func (a *Agent) apply(ports []portEntry) {
	want := map[int]string{}
	for _, p := range ports {
		want[p.Port] = p.Device
	}
	a.mu.Lock()
	defer a.mu.Unlock()
	for port, l := range a.listeners {
		if dev, ok := want[port]; !ok || dev != l.device {
			l.conn.Close()
			delete(a.listeners, port)
			delete(a.reported, port)
			delete(a.pending, port)
			a.Log.Info("stopped listening", "port", port, "device", l.device)
		}
	}
	for port, dev := range want {
		if _, ok := a.listeners[port]; ok {
			continue
		}
		conn, err := net.ListenPacket("udp", net.JoinHostPort(a.ListenIP, strconv.Itoa(port)))
		if err != nil {
			a.Log.Error("cannot listen", "port", port, "device", dev, "err", err)
			continue
		}
		l := &listener{conn: conn, device: dev}
		a.listeners[port] = l
		a.wg.Add(1)
		go a.serve(port, l)
		a.Log.Info("listening", "port", port, "device", dev)
	}
}

func (a *Agent) serve(port int, l *listener) {
	defer a.wg.Done()
	buf := make([]byte, 512)
	for {
		n, from, err := l.conn.ReadFrom(buf)
		rx := time.Now()
		if err != nil {
			if !errors.Is(err, net.ErrClosed) {
				a.Log.Error("read failed", "port", port, "err", err)
			}
			return
		}
		udp, ok := from.(*net.UDPAddr)
		if !ok {
			continue
		}
		ip := udp.IP.String()
		if v4 := udp.IP.To4(); v4 != nil {
			ip = v4.String()
		}
		if !a.allow(ip, rx) {
			continue
		}
		resp, ok := reply(buf[:n], rx, time.Now(), a.Clock(), a.Reply)
		if !ok {
			continue
		}
		if _, err := l.conn.WriteTo(resp, from); err != nil {
			a.Log.Warn("write failed", "port", port, "err", err)
		}
		a.seen(port, ip)
	}
}

func (a *Agent) allow(ip string, now time.Time) bool {
	a.mu.Lock()
	defer a.mu.Unlock()
	b, ok := a.buckets[ip]
	if !ok {
		b = &bucket{tokens: a.RateBurst, last: now}
		a.buckets[ip] = b
	}
	b.tokens = min(a.RateBurst, b.tokens+now.Sub(b.last).Seconds()*a.RatePerSecond)
	b.last = now
	if b.tokens < 1 {
		return false
	}
	b.tokens--
	return true
}

func (a *Agent) pruneBuckets() {
	a.mu.Lock()
	defer a.mu.Unlock()
	for ip, b := range a.buckets {
		if time.Since(b.last) > 10*time.Minute {
			delete(a.buckets, ip)
		}
	}
}

func (a *Agent) seen(port int, ip string) {
	a.mu.Lock()
	defer a.mu.Unlock()
	if _, ok := a.listeners[port]; !ok {
		return
	}
	r := a.reported[port]
	if r.ip != ip || (a.Heartbeat > 0 && time.Since(r.at) >= a.Heartbeat) {
		a.pending[port] = ip
	}
}

func (a *Agent) flush(ctx context.Context) error {
	a.mu.Lock()
	batch := make([]reportEntry, 0, len(a.pending))
	for port, ip := range a.pending {
		batch = append(batch, reportEntry{Port: port, IP: ip})
	}
	a.mu.Unlock()
	if len(batch) == 0 {
		return nil
	}
	slices.SortFunc(batch, func(x, y reportEntry) int { return x.Port - y.Port })

	results := a.Backend.Report(ctx, batch)
	now := time.Now()
	a.mu.Lock()
	defer a.mu.Unlock()
	var failed []string
	for i, r := range batch {
		res := results[i]
		if res.Retry {
			failed = append(failed, res.Result)
			continue
		}
		a.reported[r.Port] = reportState{ip: r.IP, at: now}
		if a.pending[r.Port] == r.IP {
			delete(a.pending, r.Port)
		}
		log := a.Log.Info
		if res.Rejected {
			log = a.Log.Error
		}
		log("reported", "port", r.Port, "device", a.deviceName(r.Port), "ip", r.IP, "result", res.Result)
	}
	if len(failed) > 0 {
		return errors.New(strings.Join(slices.Compact(failed), "; "))
	}
	return nil
}

// deviceName must be called with a.mu held.
func (a *Agent) deviceName(port int) string {
	if l, ok := a.listeners[port]; ok {
		return l.device
	}
	return ""
}

func (a *Agent) readCache() ([]portEntry, error) {
	b, err := os.ReadFile(a.CachePath)
	if err != nil {
		return nil, err
	}
	var ports []portEntry
	return ports, json.Unmarshal(b, &ports)
}

func (a *Agent) writeCache(ports []portEntry) error {
	if a.CachePath == "" {
		return nil
	}
	b, _ := json.Marshal(ports)
	if old, err := os.ReadFile(a.CachePath); err == nil && bytes.Equal(old, b) {
		return nil
	}
	tmp, err := os.CreateTemp(filepath.Dir(a.CachePath), ".ports-*.json")
	if err != nil {
		return err
	}
	defer os.Remove(tmp.Name())
	if _, err := tmp.Write(b); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	return os.Rename(tmp.Name(), a.CachePath)
}
