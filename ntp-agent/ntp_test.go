package main

import (
	"encoding/binary"
	"testing"
	"time"
)

func clientPacket(version, mode byte, tx uint64) []byte {
	p := make([]byte, 48)
	p[0] = version<<3 | mode
	p[2] = 6 // poll
	binary.BigEndian.PutUint64(p[40:], tx)
	return p
}

func TestReplyAnswersAClientRequest(t *testing.T) {
	rx := time.Date(2026, 11, 1, 10, 0, 0, 0, time.UTC)
	tx := rx.Add(50 * time.Microsecond)
	req := clientPacket(4, 3, 0x0123456789abcdef)

	resp, ok := reply(req, rx, tx, clockState{synced: true, maxError: 20 * time.Millisecond}, replyOptions{stratum: 3, refID: "LOCL"})
	if !ok {
		t.Fatal("request rejected")
	}
	if len(resp) != 48 {
		t.Fatalf("len = %d", len(resp))
	}
	if li, vn, mode := resp[0]>>6, resp[0]>>3&7, resp[0]&7; li != 0 || vn != 4 || mode != 4 {
		t.Fatalf("li=%d vn=%d mode=%d", li, vn, mode)
	}
	if resp[1] != 3 || resp[2] != 6 {
		t.Fatalf("stratum=%d poll=%d", resp[1], resp[2])
	}
	if string(resp[12:16]) != "LOCL" {
		t.Fatalf("refid = %q", resp[12:16])
	}
	if got := binary.BigEndian.Uint64(resp[24:]); got != 0x0123456789abcdef {
		t.Fatalf("origin = %x", got)
	}
	if got := fromNTP(binary.BigEndian.Uint64(resp[32:])); !got.Equal(rx) {
		t.Fatalf("receive = %v", got)
	}
	if got := fromNTP(binary.BigEndian.Uint64(resp[40:])); got.Sub(tx).Abs() > time.Microsecond {
		t.Fatalf("transmit = %v", got)
	}
	// Root dispersion reflects the clock's max error (16.16 seconds).
	if got := binary.BigEndian.Uint32(resp[8:]); got != uint32(20*65536/1000) {
		t.Fatalf("root dispersion = %d", got)
	}
}

func TestReplyEchoesOlderVersions(t *testing.T) {
	resp, ok := reply(clientPacket(3, 3, 1), time.Now(), time.Now(), clockState{synced: true}, replyOptions{stratum: 3})
	if !ok || resp[0]>>3&7 != 3 {
		t.Fatalf("ok=%v version=%d", ok, resp[0]>>3&7)
	}
}

func TestReplyFlagsAnUnsyncedClock(t *testing.T) {
	resp, ok := reply(clientPacket(4, 3, 1), time.Now(), time.Now(), clockState{synced: false}, replyOptions{stratum: 3})
	if !ok {
		t.Fatal("rejected")
	}
	if li := resp[0] >> 6; li != 3 {
		t.Fatalf("leap indicator = %d, want 3 (alarm)", li)
	}
	if resp[1] != 16 {
		t.Fatalf("stratum = %d, want 16", resp[1])
	}
}

func TestReplyIgnoresNonClientPackets(t *testing.T) {
	cases := map[string][]byte{
		"short":           make([]byte, 47),
		"server mode":     clientPacket(4, 4, 1),
		"control (mode6)": clientPacket(2, 6, 1),
		"private (mode7)": clientPacket(2, 7, 1),
		"version 0":       clientPacket(0, 3, 1),
		"version 5":       clientPacket(5, 3, 1),
	}
	for name, p := range cases {
		if _, ok := reply(p, time.Now(), time.Now(), clockState{synced: true}, replyOptions{stratum: 3}); ok {
			t.Errorf("%s: answered", name)
		}
	}
}

func TestReplyNeverAmplifies(t *testing.T) {
	req := append(clientPacket(4, 3, 1), make([]byte, 200)...) // extension fields / padding
	resp, ok := reply(req, time.Now(), time.Now(), clockState{synced: true}, replyOptions{stratum: 3})
	if !ok || len(resp) != 48 {
		t.Fatalf("ok=%v len=%d", ok, len(resp))
	}
}

func TestNTPTimestampRoundTrip(t *testing.T) {
	now := time.Date(2036, 2, 7, 6, 28, 17, 123456000, time.UTC) // past the 2036 era rollover
	if got := fromNTP(toNTP(now)); got.Sub(now).Abs() > time.Microsecond {
		t.Fatalf("got %v want %v", got, now)
	}
}
