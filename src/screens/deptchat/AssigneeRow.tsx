import React, {useEffect, useRef, useState} from 'react';
import {ActivityIndicator, Image, StyleSheet, Text, TouchableOpacity, View} from 'react-native';
import Icon from '@expo/vector-icons/MaterialCommunityIcons';
import {BravoFont} from '@theme/bravo';
import {scaleTextStyles} from '@utils/scaling';
import {
  attendanceApi,
  type ShiftAssigneeDto, type ShiftAssigneeFixDto, type ShiftAssigneePingDto,
} from '@services/api';
import {OB} from './_obsidian';
import {fmtTime} from './geo';
import {cleanPlaceName, coordText, distanceM, distanceText, useResolvedPlace, validFix} from './placeName';

/**
 * B-855 — one assigned worker on the shift detail sheet.
 *
 * The founder's ask was "when we expand each shift we should see which users
 * are assigned, their location, and all required information for each worker
 * with their picture; click to view the picture". So the row is: the photo
 * (tappable), who they are, and what they did on THIS shift.
 *
 * Two capability gates live here and nowhere else:
 *
 *  · **A9 — the old server answers 200.** `GET …/assignments` used to return
 *    `{cpo_user_id, display_name}` and still does on a server that has not been
 *    deployed yet. So "is this build talking to a new server?" is
 *    `session !== undefined` — NOT a 404, and not a truthiness check either
 *    (`null` is a real answer meaning "no session for this shift").
 *  · **membership.** `member_status` is only present on the new projection, so
 *    a MISSING value means "unknown", never "removed". Only an explicit
 *    non-active status draws the chip and withholds the Ping button — the naive
 *    `member_status !== 'active'` would mark every row of an old server's
 *    response as an ex-employee.
 */
export interface AssigneeRowProps {
  a: ShiftAssigneeDto;
  /** Full-screen photo viewer (`AvatarViewer`), owned by the sheet. */
  onOpenAvatar: (a: ShiftAssigneeDto) => void;
  /** The check-in fix on the native map (`CheckInMap`). */
  onOpenMap: (a: ShiftAssigneeDto) => void;
  /** The sealed check-in photo, by SESSION id — audited per view, so tap-only. */
  onOpenPhoto: (a: ShiftAssigneeDto) => void;
  /** B-859 slot. Absent while the ping lane is not deployed. */
  pingSlot?: React.ReactNode;
}

/**
 * Is this person explicitly NO LONGER in the workspace?
 *
 * An ABSENT `member_status` is "unknown" (the old server does not project it),
 * never "removed" — the naive `member_status !== 'active'` would chip every row
 * of an old server's response as an ex-employee and hide every Ping button.
 */
export function isRemovedMember(a: Pick<ShiftAssigneeDto, 'member_status'>): boolean {
  return typeof a.member_status === 'string' && a.member_status !== 'active';
}

export function initialsFor(a: Pick<ShiftAssigneeDto, 'display_name' | 'call_sign'>): string {
  const source = a.display_name?.trim() || a.call_sign?.trim() || 'Removed member';
  return (
    source
      .split(/[\s@._-]+/)
      .filter(Boolean)
      .map(w => w[0] ?? '')
      .join('')
      .slice(0, 2)
      .toUpperCase() || '?'
  );
}

/** The one sentence that says what this person did on THIS shift. */
export function sessionLine(
  a: Pick<ShiftAssigneeDto, 'session'>,
  place: string | null,
): string | null {
  const ses = a.session;
  // Old server — say nothing rather than invent "not checked in".
  if (ses === undefined) {return null;}
  if (!ses || ses.status === 'not_started') {return 'Not checked in for this shift';}
  const parts: string[] = [`Clocked in ${fmtTime(ses.clock_in_at)}`];
  if (place) {parts.push(place);}
  if (typeof ses.distance_m === 'number' && Number.isFinite(ses.distance_m)) {
    parts.push(`${distanceText(ses.distance_m)} from site`);
  }
  if (ses.status === 'closed' && ses.clock_out_at) {
    parts.push(`clocked out ${fmtTime(ses.clock_out_at)}`);
  }
  return parts.join(' · ');
}

export function AssigneeRow({a, onOpenAvatar, onOpenMap, onOpenPhoto, pingSlot}: AssigneeRowProps) {
  const ses = a.session;
  const removed = isRemovedMember(a);
  const resolved = useResolvedPlace(ses?.clock_in_place, ses?.clock_in_lat, ses?.clock_in_lng);
  const place = resolved.name ? (cleanPlaceName(resolved.name) || resolved.name) : null;
  const line = sessionLine(a, place);
  const canMap = validFix(ses?.clock_in_lat, ses?.clock_in_lng);
  const name = a.display_name?.trim() || a.call_sign?.trim() || 'Removed member';
  const sub = [a.call_sign, a.department].filter(Boolean).join(' · ');
  const url = a.avatar_url?.trim() || null;
  /**
   * An avatar URL is a PLAIN public URL — it can 403 after a bucket rotation or
   * simply 404. Without this the row rendered a blank circle AND stayed
   * tappable, so the tap opened a full-screen black rectangle, which reads as a
   * crash. A failed load falls back to the initials, and the tap goes with it.
   */
  const [imgFailed, setImgFailed] = useState(false);
  const avatar = imgFailed ? null : url;

  return (
    <View style={r.row}>
      {/* Tappable only when there IS a picture: a viewer opened on an initials
          fallback is a full-screen black rectangle, which reads as a crash. */}
      <TouchableOpacity
        onPress={avatar ? () => onOpenAvatar(a) : undefined}
        disabled={!avatar}
        activeOpacity={0.8}
        accessibilityRole={avatar ? 'button' : 'image'}
        accessibilityLabel={avatar ? `View ${name}'s photo` : `${name}, no profile photo`}
        testID={`assignee-avatar-${a.cpo_user_id}`}>
        <View style={r.avatar}>
          {avatar ? (
            <Image
              source={{uri: avatar}}
              style={r.avatarImg}
              accessibilityLabel={`${name} profile photo`}
              onError={() => setImgFailed(true)}
              testID={`assignee-avatar-img-${a.cpo_user_id}`}
            />
          ) : (
            <Text style={r.initials}>{initialsFor(a)}</Text>
          )}
        </View>
      </TouchableOpacity>

      <View style={{flex: 1, minWidth: 0, gap: 3}}>
        <Text style={r.name} numberOfLines={1}>{name}</Text>
        {sub ? <Text style={r.sub} numberOfLines={1}>{sub}</Text> : null}

        {removed ? (
          <View style={r.chip}>
            <Icon name="account-off-outline" size={11} color={OB.amber} />
            <Text style={r.chipText} numberOfLines={1}>No longer in this workspace</Text>
          </View>
        ) : null}

        {line ? (
          <Text style={r.line} numberOfLines={2}>{line}</Text>
        ) : null}

        <View style={r.actions}>
          {canMap ? (
            <TouchableOpacity
              onPress={() => onOpenMap(a)}
              hitSlop={{top: 8, bottom: 8, left: 8, right: 8}}
              accessibilityRole="button"
              accessibilityLabel={`Open ${name}'s check-in location on the map`}
              testID={`assignee-map-${a.cpo_user_id}`}>
              <Text style={r.action}>Open on map</Text>
            </TouchableOpacity>
          ) : null}
          {ses?.has_photo && ses.id ? (
            <TouchableOpacity
              onPress={() => onOpenPhoto(a)}
              hitSlop={{top: 8, bottom: 8, left: 8, right: 8}}
              accessibilityRole="button"
              accessibilityLabel={`View ${name}'s check-in photo`}
              testID={`assignee-photo-${a.cpo_user_id}`}>
              <Text style={r.action}>Check-in photo</Text>
            </TouchableOpacity>
          ) : null}
        </View>

        {pingSlot}
      </View>
    </View>
  );
}

/** A ping is dead after ten minutes, whatever the row still says. */
export const PING_EXPIRY_MS = 10 * 60 * 1000;

export function pingIsLive(p: ShiftAssigneePingDto | null | undefined, now = Date.now()): boolean {
  if (!p || p.status !== 'pending') {return false;}
  const at = Date.parse(p.requested_at);
  return Number.isFinite(at) && now - at < PING_EXPIRY_MS;
}

function relativeTime(iso: string | null | undefined, now = Date.now()): string {
  const t = iso ? Date.parse(iso) : NaN;
  if (!Number.isFinite(t)) {return '';}
  const mins = Math.max(0, Math.round((now - t) / 60_000));
  if (mins < 1) {return 'just now';}
  if (mins < 60) {return `${mins} min ago`;}
  const hrs = Math.round(mins / 60);
  return hrs < 24 ? `${hrs} h ago` : `${Math.round(hrs / 24)} d ago`;
}

const REFUSE_COPY: Record<string, string> = {
  no_permission: 'Location permission is off on their phone',
  no_fix:        'Their phone could not get a location',
  off_shift:     'They were no longer clocked in',
  declined:      'They declined',
};

/**
 * B-859 — what the manager reads under an assignee, and the button that asks.
 *
 * The five states are five DIFFERENT facts and the founder has to be able to
 * tell them apart at a glance, so none of them collapses into "failed":
 * `pending` (asked, nothing back yet), `answered` (a fix, with how far from
 * site), `refused` (the device said why), `expired` (ten minutes, no answer),
 * and the request-time refusal "Not clocked in" — which is not a ping at all,
 * it is the server declining to make one.
 */
export function pingLine(
  p: ShiftAssigneePingDto | null | undefined,
  site: {lat: number | null; lng: number | null} | null,
  now = Date.now(),
): string | null {
  if (!p) {return null;}
  if (p.status === 'pending') {
    return now - Date.parse(p.requested_at) >= PING_EXPIRY_MS
      ? 'No answer'
      : 'Pinged · waiting…';
  }
  if (p.status === 'expired') {return 'No answer';}
  if (p.status === 'refused') {
    const why = p.refuse_reason ? REFUSE_COPY[p.refuse_reason] : null;
    return why ? `Declined · ${why}` : 'Declined';
  }
  const parts = [`Answered ${relativeTime(p.answered_at ?? p.requested_at, now)}`];
  if (site && site.lat !== null && site.lng !== null && p.lat !== null && p.lng !== null) {
    parts.push(`${distanceText(distanceM(p.lat, p.lng, site.lat, site.lng))} from site`);
  }
  return parts.join(' · ');
}

/**
 * The Ping control. Lives on the row so it sits next to the person it names.
 *
 * N4 — the guard is a synchronous REF, not the `busy` state: a `disabled` prop
 * needs a committed re-render, which lands late exactly when the JS thread is
 * lagging, and this button spends a rate limit.
 */
export function PingControl({a, shiftId, site, onPinged, onOpenPingMap, onNotOnShift}: {
  a: ShiftAssigneeDto;
  shiftId: string;
  site: {lat: number | null; lng: number | null} | null;
  onPinged: (ping: ShiftAssigneePingDto) => void;
  onOpenPingMap: (a: ShiftAssigneeDto, fix: {lat: number; lng: number; at: string}) => void;
  /**
   * The server refused to CREATE a ping because this person is not clocked in.
   * It makes no row, so nothing about this assignee will ever change on its
   * own — the sheet uses this to keep refreshing until they do clock in.
   */
  onNotOnShift?: () => void;
}) {
  const inFlight = useRef(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  /**
   * A new REQUEST clears the last one's error.
   *
   * `error` is the local translation of a 409 ("Not clocked in", "Asked too
   * recently"), and it out-ranks the server's own line in the render. Without
   * this it outlived the request it described: the worker clocks in, the 15 s
   * poll brings a fresh `last_ping`, and the row still reads "Not clocked in"
   * over the top of it until the sheet is closed and re-opened.
   */
  const pingId = a.last_ping?.id ?? null;
  /**
   * …and so does a change of SESSION.
   *
   * `not_on_shift` is refused BEFORE a ping row exists, so `pingId` stays
   * `null` and the reset above can never fire for the one error a worker can
   * actually resolve. The manager was left reading "Not clocked in" over
   * someone who had since clocked in, with Ping dead, until the sheet was
   * closed and re-opened.
   */
  const sessionStatus = a.session?.status ?? null;
  useEffect(() => { setError(null); }, [pingId, sessionStatus]);

  // A9 — the old server answers 200 with the two-field shape, so the absence of
  // `session` is the capability probe. A missing `member_status` is "unknown",
  // never "removed" — only an explicit non-active status withholds the button.
  if (a.session === undefined) {return null;}
  if (isRemovedMember(a)) {return null;}

  const ping = a.last_ping ?? null;
  const live = pingIsLive(ping);
  const line = error ?? pingLine(ping, site);
  /**
   * The last place we actually KNOW they were — independent of the latest
   * request's state. A re-ping turns `last_ping` pending and then possibly
   * expired; without this line the manager would watch a known location
   * disappear because they asked for a fresher one.
   *
   * `last_fix` is the server's own latest-answered projection. The fallback
   * covers the deploy window where the field is absent but the latest ping
   * HAPPENS to be the answered one.
   */
  const fix = a.last_fix
    ?? (ping?.status === 'answered' && ping.lat !== null && ping.lng !== null
      ? {ping_id: ping.id, lat: ping.lat, lng: ping.lng, accuracy_m: ping.accuracy_m,
        mocked: ping.mocked, answered_at: ping.answered_at ?? ping.requested_at}
      : null);

  const press = () => {
    if (inFlight.current) {return;}
    inFlight.current = true;
    setBusy(true);
    setError(null);
    void attendanceApi.pingAssignee(shiftId, a.cpo_user_id)
      .then(({data}) => { onPinged(data.ping); })
      .catch((e: unknown) => {
        const res = (e as {response?: {status?: number; data?: {error?: string; message?: string}}})?.response;
        // D2 (B-859 E2) — MESSAGE first.
        //
        // The controller throws Nest's ConflictException('not_on_shift') and
        // there is no global exception filter, so the wire is
        // {message: 'not_on_shift', error: 'Conflict', statusCode: 409}: the code
        // is in `message`, and `error` holds the HTTP REASON PHRASE. Reading
        // `error` first compared "Conflict" against every pattern below and fell
        // through to the generic line for the one refusal a worker can resolve.
        const code = res?.data?.message ?? res?.data?.error ?? '';
        if (/not_on_shift/.test(String(code))) {onNotOnShift?.();}
        setError(
          /not_on_shift/.test(String(code)) ? 'Not clocked in'
            : /ping_pending/.test(String(code)) ? 'Pinged · waiting…'
            : /ping_rate_limited/.test(String(code)) ? 'Asked too recently — try again shortly'
            : 'Could not send the request. Try again.',
        );
      })
      .finally(() => {
        // ALWAYS, on every exit path — a throw that latched this ref would kill
        // the button for the life of the sheet.
        inFlight.current = false;
        setBusy(false);
      });
  };

  return (
    <View style={{gap: 4}}>
      <View style={r.pingRow}>
        {live ? (
          <View style={r.pingWaiting}>
            <ActivityIndicator size="small" color={OB.accentSoft} />
            <Text style={r.pingWaitText}>Pinged · waiting…</Text>
          </View>
        ) : (
          <TouchableOpacity
            style={r.pingBtn}
            activeOpacity={0.85}
            onPress={press}
            disabled={busy}
            accessibilityRole="button"
            accessibilityLabel={`Ask ${a.display_name ?? 'this member'} where they are`}
            testID={`assignee-ping-${a.cpo_user_id}`}>
            {busy
              ? <ActivityIndicator size="small" color={OB.accentSoft} />
              : <Icon name="crosshairs-question" size={14} color={OB.accentSoft} />}
            <Text style={r.pingBtnText}>Ping</Text>
          </TouchableOpacity>
        )}
        {!live && line ? <Text style={r.pingLine} numberOfLines={2}>{line}</Text> : null}
      </View>
      {/* Rendered WHENEVER a fix exists — including while a newer request is
          pending, refused or expired. Asking again must never erase the answer
          to the last question. */}
      {fix ? (
        <View style={r.pingRow} testID={`assignee-last-fix-${a.cpo_user_id}`}>
          <Icon name="map-marker-check-outline" size={13} color={OB.signal} />
          <Text style={r.pingLine} numberOfLines={2}>{lastFixLine(fix)}</Text>
          <TouchableOpacity
            onPress={() => onOpenPingMap(a, {lat: fix.lat, lng: fix.lng, at: fix.answered_at})}
            hitSlop={{top: 8, bottom: 8, left: 8, right: 8}}
            accessibilityRole="button"
            accessibilityLabel="Open the shared location on the map"
            testID={`assignee-ping-map-${a.cpo_user_id}`}>
            <Text style={r.action}>Open on map</Text>
          </TouchableOpacity>
        </View>
      ) : null}
    </View>
  );
}

/** "Last fix 14:12 · 25.20050, 55.27010 (±12 m)" — the raw fix, stated as one. */
export function lastFixLine(fix: ShiftAssigneeFixDto): string {
  const parts = [`Last fix ${fmtTime(fix.answered_at)}`, coordText(fix.lat, fix.lng)];
  if (typeof fix.accuracy_m === 'number' && Number.isFinite(fix.accuracy_m)) {
    parts.push(`±${Math.round(fix.accuracy_m)} m`);
  }
  const line = `${parts[0]} · ${parts[1]}${parts[2] ? ` (${parts[2]})` : ''}`;
  // Only an EXPLICIT true says so: absent is unknown (iOS, or an older
  // server), and captioning an unknown position as genuine is the worse half
  // of the same mistake.
  return fix.mocked === true ? `${line} · device-reported mock location` : line;
}

const r = StyleSheet.create(scaleTextStyles({
  row: {flexDirection: 'row', alignItems: 'flex-start', gap: 12, paddingVertical: 12},
  avatar: {
    width: 44, height: 44, borderRadius: 22, overflow: 'hidden',
    alignItems: 'center', justifyContent: 'center',
    backgroundColor: 'rgba(30,136,255,0.14)', borderWidth: 1, borderColor: 'rgba(30,136,255,0.28)',
  },
  avatarImg: {width: '100%', height: '100%'},
  initials: {color: OB.accentSoft, fontFamily: BravoFont.bold, fontSize: 14, letterSpacing: 0.3},
  name: {color: OB.text, fontFamily: BravoFont.bold, fontSize: 14},
  sub: {color: OB.textDim, fontFamily: BravoFont.regular, fontSize: 11.5},
  line: {color: OB.textDim, fontFamily: BravoFont.regular, fontSize: 11.5, lineHeight: 16},
  chip: {
    flexDirection: 'row', alignItems: 'center', gap: 5, alignSelf: 'flex-start',
    paddingHorizontal: 8, paddingVertical: 3, borderRadius: 8,
    backgroundColor: 'rgba(226,200,147,0.10)', borderWidth: 1, borderColor: 'rgba(226,200,147,0.28)',
  },
  chipText: {color: OB.amber, fontFamily: BravoFont.semiBold, fontSize: 10.5},
  actions: {flexDirection: 'row', gap: 16, marginTop: 2},
  action: {color: OB.accentSoft, fontFamily: BravoFont.semiBold, fontSize: 11.5},
  pingRow: {flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: 10, marginTop: 6},
  pingBtn: {
    flexDirection: 'row', alignItems: 'center', gap: 6,
    paddingVertical: 5, paddingHorizontal: 10, borderRadius: 12, borderWidth: 1,
    borderColor: 'rgba(30,136,255,0.32)', backgroundColor: 'rgba(30,136,255,0.10)',
  },
  pingBtnText: {color: OB.accentSoft, fontFamily: BravoFont.semiBold, fontSize: 11.5},
  pingWaiting: {flexDirection: 'row', alignItems: 'center', gap: 7},
  pingWaitText: {color: OB.textDim, fontFamily: BravoFont.semiBold, fontSize: 11.5},
  pingLine: {flex: 1, minWidth: 120, color: OB.textDim, fontFamily: BravoFont.regular, fontSize: 11.5, lineHeight: 16},
}));
