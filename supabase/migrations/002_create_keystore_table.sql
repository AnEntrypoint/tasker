-- Create keystore table for API credentials
CREATE TABLE IF NOT EXISTS keystore (
    id SERIAL PRIMARY KEY,
    key_name VARCHAR(255) UNIQUE NOT NULL,
    key_value TEXT NOT NULL,
    description TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Create index for faster key lookups
CREATE INDEX IF NOT EXISTS idx_keystore_key_name ON keystore(key_name);

-- Insert placeholder entries for Google API credentials
INSERT INTO keystore (key_name, key_value, description) VALUES 
(
    'GAPI_KEY',
    '',
    'Google Service Account JSON key for domain-wide delegation'
),
(
    'GAPI_ADMIN_EMAIL',
    '',
    'Google Workspace admin email with proper permissions'
) ON CONFLICT (key_name) DO NOTHING;