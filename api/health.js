export default function handler(_req, res) {
  res.status(200).json({
    ok: true,
    service: 'hyu-lan-proxy-registry',
    controlPlane: 'vercel',
    registry: 'supabase',
    time: new Date().toISOString()
  });
}
