import { hashPassword } from './auth.js';
import { prep } from './db.js';
import { toDateStr, nowISO } from './util.js';
import { pathToFileURL } from 'node:url';

const today = () => toDateStr(new Date());

const VENUES = [
  { name: '城市体育中心羽毛球馆', address: '和平区体育路 1 号', sport: '羽毛球', open: 480, close: 1320, slot: 60, courts: ['1 号场', '2 号场', '3 号场', '4 号场'], price: 40 },
  { name: '阳光游泳馆', address: '河东区滨江道 88 号', sport: '游泳', open: 540, close: 1290, slot: 60, courts: ['浅水泳道 A', '深水泳道 B', '训练泳道 C'], price: 60 },
  { name: '全民健身篮球公园', address: '南开区健身路 12 号', sport: '篮球', open: 420, close: 1380, slot: 60, courts: ['室外场 1', '室外场 2', '风雨球馆'], price: 80 },
  { name: '星火网球中心', address: '河西区星火路 9 号', sport: '网球', open: 480, close: 1320, slot: 60, courts: ['红土场 1', '红土场 2', '硬地场 3', '室内场 4'], price: 100 },
  { name: '国球乒乓球俱乐部', address: '红桥区文化街 5 号', sport: '乒乓球', open: 540, close: 1320, slot: 60, courts: ['台 1', '台 2'], price: 30 },
];

export function seedIfEmpty() {
  const count = Number(prep('SELECT COUNT(*) AS c FROM venues').get().c);
  if (count > 0) return;

  const now = nowISO();
  const users = [
    { name: '系统管理员', email: 'admin@yueqiu.local', phone: '13900000001', password: 'admin123456', role: 'admin', real_name: '王管理', id_card: '110101199001010011' },
    { name: '演示用户', email: 'demo@yueqiu.local', phone: '13800000000', password: 'demo123456', role: 'user', real_name: '李小明', id_card: '110101199505050022' },
    { name: '张同学', email: 'zhang@yueqiu.local', phone: '13800000002', password: 'user123456', role: 'user', real_name: '张伟', id_card: '110101200002020033' },
  ];
  for (const u of users) {
    prep(`INSERT INTO users (name, phone, email, password_hash, real_name, id_card, role, points, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, 100, ?)`)
      .run(u.name, u.phone, u.email, hashPassword(u.password), u.real_name, u.id_card, u.role, now);
  }

  for (const v of VENUES) {
    const res = prep(`INSERT INTO venues (name, address, sport, open_minute, close_minute, slot_minutes, status, created_at)
                      VALUES (?, ?, ?, ?, ?, ?, 'open', ?)`)
      .run(v.name, v.address, v.sport, v.open, v.close, v.slot, now);
    const venueId = Number(res.lastInsertRowid);
    for (const court of v.courts) {
      prep('INSERT INTO courts (venue_id, name, price_per_hour, status) VALUES (?, ?, ?, ?)')
        .run(venueId, court, v.price, 'open');
    }
  }

  // 造几条今天的占位预约 + 一条维护时段，让可用性视图一开始就有数据
  const day = today();
  const demo = prep('SELECT * FROM users WHERE phone = ?').get('13800000000');
  const seeds = [
    { courtId: 1, start: 600, end: 660 },
    { courtId: 1, start: 1140, end: 1260 },
    { courtId: 2, start: 720, end: 780 },
    { courtId: 5, start: 1080, end: 1140 },
    { courtId: 9, start: 900, end: 960 },
  ];
  for (const s of seeds) {
    const court = prep('SELECT * FROM courts WHERE id = ?').get(s.courtId);
    if (!court) continue;
    const amount = Math.round(((s.end - s.start) / 60) * court.price_per_hour);
    prep(`INSERT INTO bookings (code, venue_id, court_id, user_id, date, start_min, end_min, amount, status, qr, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'confirmed', ?, ?)`)
      .run(`SEED${s.courtId}${s.start}`, court.venue_id, court.id, demo.id, day, s.start, s.end, amount, `SEED-${court.id}-${s.start}`, now);
  }
  prep(`INSERT INTO slot_overrides (court_id, date, start_min, end_min, status, note, created_at)
        VALUES (3, ?, 480, 540, 'maintenance', '篮网更换', ?)`).run(day, now);

  console.log('[seed] 初始化完成：5 个场馆、16 片场地、3 个账号（admin@yueqiu.local / admin123456）');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  seedIfEmpty();
}
