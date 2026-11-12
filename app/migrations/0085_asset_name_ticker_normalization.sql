-- 0085_asset_name_ticker_normalization.sql
-- 1) Partial index on transactions(ticker) to speed up GET /assets query
CREATE INDEX IF NOT EXISTS idx_tx_ticker_live
  ON transactions (ticker)
  WHERE deprecated_at IS NULL;

-- 2) Clean up crypto tickers (map $ETHUSD, ETHUSD, BTCUSD -> ETH, BTC, etc.)
UPDATE transactions SET ticker = 'ETH' WHERE ticker IN ('ETHUSD', 'ETH-USD', 'ETH/USD', '$ETHUSD', '$ETH');
UPDATE transactions SET ticker = 'BTC' WHERE ticker IN ('BTCUSD', 'BTC-USD', 'BTC/USD', 'XBTUSD', '$BTCUSD', '$BTC');
UPDATE transactions SET ticker = 'SOL' WHERE ticker IN ('SOLUSD', 'SOL-USD', 'SOL/USD', '$SOLUSD', '$SOL');
UPDATE transactions SET ticker = 'DOGE' WHERE ticker IN ('DOGEUSD', 'DOGE-USD', '$DOGEUSD', '$DOGE');
UPDATE transactions SET ticker = 'XRP' WHERE ticker IN ('XRPUSD', 'XRP-USD', '$XRPUSD', '$XRP');
UPDATE transactions SET ticker = 'ADA' WHERE ticker IN ('ADAUSD', 'ADA-USD', '$ADAUSD', '$ADA');
UPDATE transactions SET ticker = 'AVAX' WHERE ticker IN ('AVAXUSD', 'AVAX-USD', '$AVAXUSD', '$AVAX');
UPDATE transactions SET ticker = 'DOT' WHERE ticker IN ('DOTUSD', 'DOT-USD', '$DOTUSD', '$DOT');
UPDATE transactions SET ticker = 'MATIC' WHERE ticker IN ('MATICUSD', 'POLUSD', 'MATIC-USD', '$MATICUSD', '$MATIC');
UPDATE transactions SET ticker = 'LINK' WHERE ticker IN ('LINKUSD', 'LINK-USD', '$LINKUSD', '$LINK');
UPDATE transactions SET ticker = 'LTC' WHERE ticker IN ('LTCUSD', 'LTC-USD', '$LTCUSD', '$LTC');

-- 3) Clean up corrupted dollar amount asset names and tickers ($151,000)
UPDATE transactions SET asset_name = 'Unspecified Asset', ticker = NULL WHERE asset_name LIKE '$151,000%' OR ticker LIKE '$151,000%';

-- 4) Clean up Treasury CUSIP tickers & names
UPDATE transactions SET asset_name = 'U.S. Treasury Bill', ticker = NULL WHERE ticker LIKE '912796%' OR asset_name LIKE '912796%' OR asset_name LIKE '%13-WEEK, MATURESP%' OR asset_name LIKE '%4-WEEK, MATURESP%' OR asset_name LIKE '%3-MONTH, MATURESP%' OR asset_name LIKE '%6-MONTH, MATURESP%';
UPDATE transactions SET asset_name = 'U.S. Treasury Note', ticker = NULL WHERE ticker LIKE '91282C%' OR asset_name LIKE '91282C%';

-- 5) Clear numeric/garbage OCR tickers
UPDATE transactions SET ticker = NULL WHERE ticker IN ('1 1', '2 1', '5 1', '1093', '2020', '9201', '9843', '1QY', '3733Z', '559242Z', '5672A', '600690', '7410Z', '8376923Z', '^MWE', '^RGP', '0QZI.IL', '9201:JP', '559242Z:CN', '1494391D', '20030NCU3', '30303M8N5', '37045XCR5', '37045XDS2', '605699PU5', '64110LAS5', '68389XCD5', '713448FM5', '784532JF1', '92343VEU4');

-- 6) Seed crypto securities_ref entries if missing
INSERT OR IGNORE INTO securities_ref (ticker, company_name, asset_class) VALUES
  ('ETH', 'Ethereum', 'Crypto'),
  ('BTC', 'Bitcoin', 'Crypto'),
  ('SOL', 'Solana', 'Crypto'),
  ('DOGE', 'Dogecoin', 'Crypto'),
  ('XRP', 'XRP', 'Crypto'),
  ('ADA', 'Cardano', 'Crypto'),
  ('AVAX', 'Avalanche', 'Crypto'),
  ('DOT', 'Polkadot', 'Crypto'),
  ('MATIC', 'Polygon', 'Crypto'),
  ('LINK', 'Chainlink', 'Crypto'),
  ('LTC', 'Litecoin', 'Crypto');
