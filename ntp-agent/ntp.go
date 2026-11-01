package main

import (
	"encoding/binary"
	"net"
	"time"
)

// Seconds between the NTP epoch (1900) and the Unix epoch (1970).
const ntpEpochOffset = 2208988800

type clockState struct {
	synced   bool
	maxError time.Duration
}

type replyOptions struct {
	stratum byte
	refID   string // 4 ASCII chars, or an IPv4 address of the upstream server
}

func toNTP(t time.Time) uint64 {
	secs := uint64(t.Unix()+ntpEpochOffset) & 0xffffffff
	frac := uint64(t.Nanosecond()) << 32 / 1e9
	return secs<<32 | frac
}

// fromNTP assumes timestamps between 1968 and 2104 (NTP era 0 or 1).
func fromNTP(v uint64) time.Time {
	secs := int64(v >> 32)
	if secs < 1<<31 {
		secs += 1 << 32 // era 1, after 2036-02-07
	}
	nsec := int64((v & 0xffffffff) * 1e9 >> 32)
	return time.Unix(secs-ntpEpochOffset, nsec).UTC()
}

func refIDBytes(s string) [4]byte {
	var b [4]byte
	if ip := net.ParseIP(s).To4(); ip != nil {
		copy(b[:], ip)
	} else {
		copy(b[:], s)
	}
	return b
}

// reply builds the server answer to an NTP client request (RFC 5905, mode 3).
// Anything that is not a client request is ignored: no control (mode 6) or
// private (mode 7) queries, and never an answer larger than the request.
func reply(req []byte, rx, tx time.Time, clock clockState, opt replyOptions) ([]byte, bool) {
	if len(req) < 48 {
		return nil, false
	}
	version, mode := req[0]>>3&7, req[0]&7
	if mode != 3 || version < 1 || version > 4 {
		return nil, false
	}

	resp := make([]byte, 48)
	leap, stratum := byte(0), opt.stratum
	if !clock.synced {
		leap, stratum = 3, 16 // alarm: clients must not trust this time
	}
	resp[0] = leap<<6 | version<<3 | 4
	resp[1] = stratum
	resp[2] = req[2] // poll, echoed
	resp[3] = 0xec   // precision 2^-20 s (~1µs), as int8 -20
	binary.BigEndian.PutUint32(resp[4:], 0)
	binary.BigEndian.PutUint32(resp[8:], uint32(clock.maxError.Seconds()*65536))
	ref := refIDBytes(opt.refID)
	copy(resp[12:16], ref[:])
	binary.BigEndian.PutUint64(resp[16:], toNTP(rx.Truncate(time.Second)))
	copy(resp[24:32], req[40:48]) // origin = client's transmit timestamp
	binary.BigEndian.PutUint64(resp[32:], toNTP(rx))
	binary.BigEndian.PutUint64(resp[40:], toNTP(tx))
	return resp, true
}
