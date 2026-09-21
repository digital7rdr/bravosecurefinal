/**
 * Attendance verification for managers (founder, 2026-09-05) — the WIRING,
 * pinned as static source scans (comments stripped; CRLF-safe; anchored on the
 * shapes the code uses). What would regress silently:
 *
 *  - the check-in frame leaking beyond its one sealed upload: the verify screen
 *    must delete the local file after the upload attempt, and the server must
 *    keep the manager read behind the org-manager guard AND audit it;
 *  - the purge rule drifting from "review decided AND shift done";
 *  - the export growing a photo column (it must stay biometric-free);
 *  - a tile or a row losing its door (people list, member record, map);
 *  - the place name being a code: the label rule prefers the geocoded name.
 */
import {readFileSync} from 'node:fs';
import {join} from 'node:path';

const ROOT = process.cwd();

function code(rel: string): string {
  const src = readFileSync(join(ROOT, rel), 'utf8').replace(/\r\n/g, '\n');
  const out: string[] = [];
  let inBlock = false;
  for (const line of src.split('\n')) {
    const t = line.trim();
    if (inBlock) { if (t.includes('*/')) {inBlock = false;} continue; }
    if (t.startsWith('/*') || t.startsWith('{/*')) { if (!t.includes('*/')) {inBlock = true;} continue; }
    if (t.startsWith('*') || t.startsWith('//')) {continue;}
    out.push(line.replace(/([^:'"`])\/\/.*$/, '$1'));
  }
  return out.join('\n');
}

const VERIFY = 'src/screens/deptchat/VerifyAttendanceScreen.tsx';
const FACE = 'src/screens/deptchat/faceCheck.ts';
const PHOTO_SVC = 'apps/auth-service/src/attendance/attendance-photo.service.ts';
const CTRL = 'apps/auth-service/src/attendance/attendance.controller.ts';
const SVC = 'apps/auth-service/src/attendance/attendance.service.ts';
const ADMIN = 'src/screens/deptchat/AdminAttendanceScreen.tsx';

describe('the frame leaves the device ONCE, into the sealed lane, then is deleted', () => {
  it('the verify screen keeps the frame only for the check-in upload and deletes it on every path', () => {
    const src = code(VERIFY);
    expect(src).toMatch(/runFaceCheck\(photo\.uri, \{keep\}\)/);
    expect(src).toMatch(/const keep = !isCheckout && !!photo\?\.uri;/);
    expect(src).toMatch(/attendanceApi\.uploadCheckInPhoto\(data\.id, photoUri\)/);
    // After the upload attempt AND on a throw before it.
    expect((src.match(/void deleteCapture\(/g) ?? []).length).toBeGreaterThanOrEqual(2);
    const face = code(FACE);
    expect(face).toMatch(/if \(!opts\.keep\) \{void deleteCapture\(photoUri\);\}/);
  });

  it('the server seals with the session as AAD, sniffs the mime and stores once', () => {
    const src = code(PHOTO_SVC);
    expect(src).toMatch(/sealPhoto\(bytes, this\.key\(\), sessionId\)/);
    expect(src).toMatch(/sniffImageMime\(bytes\)/);
    expect(src).toMatch(/ON CONFLICT \(session_id\) DO NOTHING/);
    expect(src).toMatch(/ses\.cpo_user_id !== cpoUserId\) throw new ForbiddenException/);
  });

  it('the manager read is behind the org-manager guard, branch-scoped, and audited', () => {
    const ctrl = code(CTRL);
    const at = ctrl.indexOf("@Get('sessions/:id/photo')");
    expect(at).toBeGreaterThan(-1);
    expect(ctrl.slice(at, at + 200)).toMatch(/@UseGuards\(DeptChatV2Guard, OrgManagerGuard\)/);
    expect(ctrl).toMatch(/res\.setHeader\('Cache-Control', 'no-store'\)/);
    const svc = code(PHOTO_SVC);
    expect(svc).toMatch(/COALESCE\(sh\.department, om\.department\) = \$3\) AS in_branch/);
    expect(svc).toMatch(/'attendance\.photo\.view'/);
  });

  it('purge = review decided AND shift done (or the hard TTL); the review hook calls it', () => {
    const svc = code(PHOTO_SVC);
    expect(svc).toMatch(/ses\.review_status <> 'pending'/);
    expect(svc).toMatch(/sh\.end_at < NOW\(\)/);
    expect(code(CTRL)).toMatch(/this\.photos\.purgeIfDue\(id\)/);
  });

  it('the CSV export stays biometric-free: no photo column, no sealed bytes', () => {
    const svc = code(SVC);
    const start = svc.indexOf('async exportSessions(');
    expect(start).toBeGreaterThan(-1);
    const fn = svc.slice(start, start + 3000);
    expect(fn).not.toMatch(/attendance_checkin_photos|sealed|has_photo/);
  });
});

describe('who / where / when → the doors', () => {
  it('the tiles open the people list over the same window; a row opens the member; a place opens the map', () => {
    const admin = code(ADMIN);
    expect(admin).toMatch(/navigateOnce\(navigation, 'AttendanceDay', \{/);
    expect(admin).toMatch(/from: w\.from, to: w\.to/);
    expect(admin).toMatch(/navigateOnce\(navigation, 'MemberAttendance'/);
    expect(admin).toMatch(/navigateOnce\(navigation, 'CheckInMap'/);
    for (const screen of ['AttendanceDayScreen', 'MemberAttendanceScreen']) {
      const src = code(`src/screens/deptchat/${screen}.tsx`);
      expect(src).toMatch(/navigateOnce\(navigation, 'CheckInMap'/);
      expect(src).toMatch(/CheckInPhotoModal/);
    }
    expect(code('src/screens/deptchat/AttendanceDayScreen.tsx')).toMatch(/navigateOnce\(navigation, 'MemberAttendance'/);
  });

  it('the three screens are registered on the attendance stack with typed params', () => {
    const nav = code('src/navigation/DepartmentalNavigator.tsx');
    for (const name of ['AttendanceDay', 'MemberAttendance', 'CheckInMap']) {
      expect(nav).toMatch(new RegExp(`<AttendStack\\.Screen name="${name}"`));
    }
    const types = code('src/navigation/types.ts');
    expect(types).toMatch(/AttendanceDay: \{status: string;/);
    expect(types).toMatch(/MemberAttendance: \{cpoUserId: string;/);
    expect(types).toMatch(/CheckInMap: \{lat: number; lng: number;/);
  });

  it('the map is native Mapbox only — no external map hand-off', () => {
    const map = code('src/screens/deptchat/CheckInMapScreen.tsx');
    expect(map).toMatch(/from '@rnmapbox\/maps'/);
    expect(map).not.toMatch(/Linking\.openURL|google\.com\/maps|geo:/);
  });

  it('the server reverse-geocodes the fix after the row exists, and never blocks a check-in on it', () => {
    const svc = code(SVC);
    expect(svc).toMatch(/this\.geocodePlace\(row\.id, 'clock_in_place', input\.lat, input\.lng\)/);
    expect(svc).toMatch(/this\.geocodePlace\(row\.id, 'clock_out_place', input\.lat, input\.lng\)/);
    const fn = svc.slice(svc.indexOf('private geocodePlace('), svc.indexOf('private geocodePlace(') + 900);
    expect(fn).toMatch(/void this\.geocode\.reverseAddress\(lat, lng\)/);
    expect(fn).toMatch(/\.catch\(\(\) => undefined\)/);
    // Address / POI first — "exact loc name", not a region code.
    expect(code('apps/auth-service/src/vbg/geocode.service.ts')).toMatch(/types=address,poi,neighborhood,locality,place/);
  });

  it('the day + history reads carry name, place, fix and has_photo, and the pending queue shares the shape', () => {
    const svc = code(SVC);
    const sel = svc.slice(svc.indexOf('DAY_ROW_SELECT = `'), svc.indexOf('private dayRowSelect()'));
    for (const col of ['u.display_name', 'om.call_sign', 'sh.site_label', '(p.session_id IS NOT NULL) AS has_photo', 'ses.*']) {
      expect(sel).toContain(col);
    }
    expect(svc).toMatch(/async orgDay\(/);
    expect(svc).toMatch(/async memberHistory\(/);
    expect(svc).toMatch(/computeAttendanceKpis\(sessions\)/);
    const pq = svc.slice(svc.indexOf('async pendingQueue('), svc.indexOf('async pendingQueue(') + 900);
    expect(pq).toMatch(/AttendanceService\.dayRowSelect\(folds\)/);
    // The fold is visible IN the reader (the A7.4 / N4 gate), not hidden in the helper.
    expect(pq).toMatch(/effectiveField\(/);
    expect(pq).toMatch(/ses\.review_status = 'pending'/);
  });
});
