# Changelog

All notable changes to this integration are documented in this file. The format
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project
uses [semantic versioning](https://semver.org/).

Describe each change under `## [Unreleased]` as you make it. The Release
workflow moves that section under the version it ships, and the section becomes
the notes of the version's GitHub Release.

## [Unreleased]

### Added

- First version: a Droplet (Hydrific) water flow sensor read through its local
  WebSocket (TLS, certificate pinned at the first connection, pairing code
  sent only after it). One device per Droplet met at the address: flow rate
  (m³/h), a water index in litres built from the volumes the Droplet reports
  (kept in /data, never 0, never lower than before, reports too large held
  until accepted in two clicks), server connectivity, signal quality, leak and
  unusual flow alerts. Connection paced (never two attempts less than 30 s
  apart, kept across restarts), pings every 30 s, pairing code refused kept
  without retries (lifted only by data of the Droplet), 429/5xx pause, test
  button. Read-only.
