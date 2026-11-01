package main

import (
	"encoding/binary"
	"errors"
	"net"
	"time"
)

type probeResult struct {
	Offset  time.Duration
	RTT     time.Duration
	Stratum byte
	Leap    byte
}

// probe sends one NTP client request, like a router would.
func probe(addr string, timeout time.Duration) (probeResult, error) {
	conn, err := net.Dial("udp", addr)
	if err != nil {
		return probeResult{}, err
	}
	defer conn.Close()
	conn.SetDeadline(time.Now().Add(timeout))

	req := make([]byte, 48)
	req[0] = 4<<3 | 3
	t1 := time.Now()
	binary.BigEndian.PutUint64(req[40:], toNTP(t1))
	if _, err := conn.Write(req); err != nil {
		return probeResult{}, err
	}
	resp := make([]byte, 512)
	n, err := conn.Read(resp)
	t4 := time.Now()
	if err != nil {
		return probeResult{}, err
	}
	if n < 48 || resp[0]&7 != 4 || !bytesEqual(resp[24:32], req[40:48]) {
		return probeResult{}, errors.New("invalid answer")
	}
	t2 := fromNTP(binary.BigEndian.Uint64(resp[32:]))
	t3 := fromNTP(binary.BigEndian.Uint64(resp[40:]))
	return probeResult{
		Offset:  (t2.Sub(t1) + t3.Sub(t4)) / 2,
		RTT:     t4.Sub(t1) - t3.Sub(t2),
		Stratum: resp[1],
		Leap:    resp[0] >> 6,
	}, nil
}

func bytesEqual(a, b []byte) bool { return string(a) == string(b) }
