package main

import (
	"time"

	"golang.org/x/sys/unix"
)

// systemClock reads the kernel's view of time synchronisation (kept by
// systemd-timesyncd or chrony), so the agent never queries upstream itself.
func systemClock() clockState {
	var tx unix.Timex
	state, err := unix.Adjtimex(&tx)
	if err != nil {
		return clockState{synced: false}
	}
	return clockState{
		synced:   state != unix.TIME_ERROR,
		maxError: time.Duration(tx.Maxerror) * time.Microsecond,
	}
}
