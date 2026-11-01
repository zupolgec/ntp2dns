//go:build !linux

package main

// Outside Linux (local development) the clock is assumed synchronised.
func systemClock() clockState {
	return clockState{synced: true}
}
