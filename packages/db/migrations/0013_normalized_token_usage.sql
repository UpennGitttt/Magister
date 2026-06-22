ALTER TABLE token_usage_records ADD COLUMN non_cached_input_tokens INTEGER;
ALTER TABLE token_usage_records ADD COLUMN reasoning_tokens INTEGER;
ALTER TABLE token_usage_records ADD COLUMN total_tokens INTEGER;
ALTER TABLE token_usage_records ADD COLUMN usage_source TEXT;
ALTER TABLE token_usage_records ADD COLUMN raw_usage_json TEXT;
