dist/ntp-agent-linux-amd64: *.go go.mod go.sum
	GOOS=linux GOARCH=amd64 CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o $@ .

test:
	go test -race ./...

.PHONY: test
