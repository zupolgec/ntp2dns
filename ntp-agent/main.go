// ntp-agent answers NTP requests on one UDP port per device, using the
// server's own synchronised clock, and updates each device's DNS name with the
// address it calls from: through the ntp2dns Worker, or straight with any
// dyndns2 provider listed in a config file.
package main

import (
	"context"
	"flag"
	"fmt"
	"log/slog"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"
)

const usage = `usage:
  ntp-agent serve [flags]     run the agent
  ntp-agent probe HOST:PORT   send one NTP request and print the answer

serve needs one of:
  -config FILE   devices and their dyndns2 providers (or DDNS_CONFIG)
  -api URL       the ntp2dns Worker (or DDNS_API), with DDNS_AGENT_TOKEN
                 or -token-file (DDNS_AGENT_TOKEN_FILE)
`

func main() {
	if len(os.Args) < 2 {
		fmt.Fprint(os.Stderr, usage)
		os.Exit(2)
	}
	switch os.Args[1] {
	case "serve":
		os.Exit(serveCmd(os.Args[2:]))
	case "probe":
		os.Exit(probeCmd(os.Args[2:]))
	default:
		fmt.Fprint(os.Stderr, usage)
		os.Exit(2)
	}
}

func env(key, def string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return def
}

func serveCmd(args []string) int {
	fs := flag.NewFlagSet("serve", flag.ExitOnError)
	config := fs.String("config", env("DDNS_CONFIG", ""), "JSON file listing ports and their dyndns2 providers")
	api := fs.String("api", env("DDNS_API", ""), "Worker base URL, e.g. https://ddns.example.com")
	tokenFile := fs.String("token-file", env("DDNS_AGENT_TOKEN_FILE", ""), "file holding the agent token (else DDNS_AGENT_TOKEN)")
	listen := fs.String("listen", "", "IP to listen on (default: all)")
	configEvery := fs.Duration("config-interval", time.Minute, "how often to reload the port list")
	heartbeat := fs.Duration("heartbeat", 15*time.Minute, "re-report an unchanged IP this often (Worker only)")
	cache := fs.String("cache", "/var/lib/ntp-agent/ports.json", "port list cache, used if the Worker is unreachable at start")
	stratum := fs.Int("stratum", 3, "stratum to announce")
	refID := fs.String("refid", "LOCL", "reference id to announce (4 chars or upstream IPv4)")
	rate := fs.Float64("rate", 2, "requests per second allowed per source IP")
	burst := fs.Float64("burst", 10, "burst allowed per source IP")
	globalRate := fs.Float64("global-rate", 200, "requests per second allowed from all sources together")
	verbose := fs.Bool("v", false, "debug logging")
	fs.Parse(args)

	var b backend
	var target string
	switch {
	case *config != "" && *api != "":
		fmt.Fprintln(os.Stderr, "use either -config or -api, not both")
		return 2
	case *config != "":
		d, err := loadDirect(*config)
		if err != nil {
			fmt.Fprintln(os.Stderr, err)
			return 2
		}
		b, target, *heartbeat = d, *config, 0
	case *api != "":
		token := os.Getenv("DDNS_AGENT_TOKEN")
		if *tokenFile != "" {
			raw, err := os.ReadFile(*tokenFile)
			if err != nil {
				fmt.Fprintln(os.Stderr, "cannot read token file:", err)
				return 1
			}
			token = strings.TrimSpace(string(raw))
		}
		if token == "" {
			fmt.Fprintln(os.Stderr, "missing agent token: set DDNS_AGENT_TOKEN or -token-file")
			return 2
		}
		target = strings.TrimRight(*api, "/")
		b = &workerBackend{API: target, Token: token}
	default:
		fmt.Fprint(os.Stderr, usage)
		return 2
	}
	if *stratum < 1 || *stratum > 15 {
		fmt.Fprintln(os.Stderr, "stratum must be 1-15")
		return 2
	}

	level := slog.LevelInfo
	if *verbose {
		level = slog.LevelDebug
	}
	a := &Agent{
		Backend:        b,
		ListenIP:       *listen,
		ConfigInterval: *configEvery,
		FlushInterval:  2 * time.Second,
		Heartbeat:      *heartbeat,
		CachePath:      *cache,
		Reply:          replyOptions{stratum: byte(*stratum), refID: *refID},
		Clock:          systemClock,
		RatePerSecond:  *rate,
		RateBurst:      *burst,
		GlobalRate:     *globalRate,
		GlobalBurst:    2 * *globalRate,
		MaxSources:     10000,
		Log:            slog.New(slog.NewTextHandler(os.Stdout, &slog.HandlerOptions{Level: level})),
	}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	a.Log.Info("starting", "backend", target, "clock_synced", systemClock().synced)
	if err := a.Run(ctx); err != nil {
		a.Log.Error("stopped", "err", err)
		return 1
	}
	return 0
}

func probeCmd(args []string) int {
	fs := flag.NewFlagSet("probe", flag.ExitOnError)
	timeout := fs.Duration("timeout", 3*time.Second, "how long to wait for the answer")
	fs.Parse(args)
	if fs.NArg() != 1 {
		fmt.Fprint(os.Stderr, usage)
		return 2
	}
	r, err := probe(fs.Arg(0), *timeout)
	if err != nil {
		fmt.Fprintln(os.Stderr, "no answer:", err)
		return 1
	}
	fmt.Printf("offset=%v rtt=%v stratum=%d leap=%d\n", r.Offset.Round(time.Microsecond), r.RTT.Round(time.Microsecond), r.Stratum, r.Leap)
	return 0
}
