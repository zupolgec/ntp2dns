# Decisions

## NTP updates are unauthenticated (2026-11-01)

The NTP path has no credential: whoever sends a time request to a device's
port publishes their own address for that device. No source spoofing is
needed. This is accepted on purpose: the whole point is to serve devices that
can only ask for the time, and a plain NTP request has nowhere to carry a
password. The README's "Security" section tells users not to trust these
names for access control.

Possible hardening, not planned yet, each optional per device:

- **NTP symmetric keys** (RFC 5905 MAC, MD5/SHA1): many routers and firewalls
  can sign their NTP requests with a shared key. Real authentication for the
  devices that support it, with no change of protocol.
- **Allowed networks**: accept updates only from given prefixes or networks
  (the customer's ISP). Stops the rest of the internet, not a neighbour on the
  same network.
- **Confirm before moving**: move the name only after several requests from
  the new address spread over time. One packet is no longer enough; legitimate
  changes arrive a little later.
