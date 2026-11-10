/**
 * Human labels for `/api/health` pipeline check ids (admin surfaces).
 */

export const PIPELINE_CHECK_LABELS: Record<string, string> = {
  ingestion_backlog: 'Ingestion Backlog',
  ingestion_dead_letter: 'Ingestion Dead Letter',
  cron_deadline: 'Cron Deadline',
  delivery_quarantine: 'Delivery Quarantine',
  extraction_provider: 'Extraction Provider',
  filing_skips: 'Filing Skips',
  fmp_latency: 'FMP Latency',
  extraction_backlog: 'Extraction Backlog',
  autopilot_halt: 'Autopilot Halt',
  data_freshness: 'Latest Transaction',
  review_resolution_integrity: 'Review Resolution Integrity',
  stranded_filings: 'Stranded Filings',
  polling_house: 'House Polling',
  polling_senate: 'Senate Polling',
  polling_executive: 'Executive Polling',
  polling_liveness: 'Polling Liveness',
  latency_probes: 'Latency Probes',
  senate_relay: 'Senate Relay',
  senate_efd: 'Senate eFD',
  price_freshness: 'Price / S&P Freshness',
  st_peer_prices: 'ST → CT Peer Prices',
};

export function pipelineCheckLabel(id: string): string {
  return PIPELINE_CHECK_LABELS[id] ?? id.replace(/_/g, ' ');
}
