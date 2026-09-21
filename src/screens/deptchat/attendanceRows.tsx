import React from 'react';
import {StyleSheet, Text, TouchableOpacity, View} from 'react-native';
import Icon from '@expo/vector-icons/MaterialCommunityIcons';
import {BravoFont} from '@theme/bravo';
import {scaleTextStyles} from '@utils/scaling';
import type {ShiftSessionDto} from '@services/api';
import {OB, Card, attendanceStatusMeta, reviewReasonLabel} from './_obsidian';
import {fmtTime} from './geo';
import {hasFix, lateBy, placeLabel} from './attendanceDay';
import {cleanPlaceName, useResolvedPlace} from './placeName';

/**
 * Shared row + KPI tile for the manager's attendance verification screens
 * (founder, 2026-09-05). One row shape for "who is in" and for a member's
 * history, so the two never drift: name, status, WHERE (tap → map), WHEN,
 * how late, and the photo door when a viewable photo exists.
 */
export function SessionRow({s, showName, onOpenMap, onOpenPhoto, onPress}: {
  s: ShiftSessionDto;
  showName: boolean;
  onOpenMap: (s: ShiftSessionDto) => void;
  onOpenPhoto: (s: ShiftSessionDto) => void;
  onPress?: (s: ShiftSessionDto) => void;
}) {
  const meta = attendanceStatusMeta(s.attendance_status);
  const late = lateBy(s);
  const reason = reviewReasonLabel(s.review_reason);
  // Founder 2026-09-05 — the WHERE line used to print a raw coordinate for
  // every check-in the server never named (all of them, before `clock_in_place`
  // existed). Resolve it from the fix instead; the coordinate stays as the
  // last-resort text, and the resolver caches per ~11 m cell so a list of one
  // site's shifts costs ONE request, not one per row.
  const resolved = useResolvedPlace(s.clock_in_place, s.clock_in_lat, s.clock_in_lng);
  // B-806 — the CLEANED name, whole. Not the raw Mapbox string ("Turag,
  // Dhaka, ঢাকা, Dhaka, Bangladesh") and not a two-component crop:
  // an address geocode is "House 12, Road 5, Dhanmondi, Dhaka", whose first two
  // are a number and a street with no city. The row allows two lines.
  const place = resolved.name ? (cleanPlaceName(resolved.name) || resolved.name) : placeLabel(s);
  const canMap = hasFix(s);
  const day = new Date(s.clock_in_at);
  const dayLabel = Number.isNaN(day.getTime()) ? '' : day.toLocaleDateString('en-GB', {weekday: 'short', day: '2-digit', month: 'short'});
  return (
    <Card style={{gap: 10}} onPress={onPress ? () => onPress(s) : undefined}
      accessibilityLabel={`${showName ? (s.display_name ?? 'Member') + ', ' : ''}${meta.label}, ${place}, ${fmtTime(s.clock_in_at)}`}>
      <View style={r.top}>
        <Icon name={meta.icon} size={18} color={meta.color} />
        <View style={{flex: 1, minWidth: 0}}>
          <Text style={r.primary} numberOfLines={1}>
            {showName ? (s.display_name ?? s.cpo_user_id.slice(0, 8)) : dayLabel}
            {showName && s.call_sign ? <Text style={r.callSign}>  {s.call_sign}</Text> : null}
          </Text>
          <Text style={[r.status, {color: meta.color}]} numberOfLines={1}>
            {meta.label}{late !== null ? ` · ${late} min late` : ''}{reason ? ` · ${reason}` : ''}
            {!showName && s.department ? ` · ${s.department}` : ''}
          </Text>
        </View>
        <View style={{alignItems: 'flex-end'}}>
          <Text style={r.time}>{fmtTime(s.clock_in_at)}</Text>
          <Text style={r.timeSub}>{s.clock_out_at ? `→ ${fmtTime(s.clock_out_at)}` : 'on duty'}</Text>
        </View>
      </View>
      <View style={r.where}>
        <TouchableOpacity
          style={[r.placeBtn, !canMap && r.placeBtnOff]}
          activeOpacity={0.8}
          disabled={!canMap}
          accessibilityRole="button"
          accessibilityLabel={canMap ? `Show ${place} on the map` : 'No location recorded'}
          onPress={() => onOpenMap(s)}>
          <Icon name={canMap ? 'map-marker' : 'map-marker-off'} size={15} color={canMap ? OB.accentSoft : OB.textMute} />
          <Text style={[r.placeText, !canMap && {color: OB.textMute}]} numberOfLines={2}>{place}</Text>
        </TouchableOpacity>
        {s.has_photo ? (
          <TouchableOpacity
            style={r.photoBtn}
            activeOpacity={0.8}
            accessibilityRole="button"
            accessibilityLabel="View check-in face photo"
            onPress={() => onOpenPhoto(s)}>
            <Icon name="face-recognition" size={16} color={OB.accentSoft} />
            <Text style={r.photoText}>Face</Text>
          </TouchableOpacity>
        ) : null}
      </View>
    </Card>
  );
}

export function KpiTile({label, value, color, sub}: {label: string; value: string; color?: string; sub?: string}) {
  return (
    <Card style={r.kpi}>
      <Text style={[r.kpiValue, color ? {color} : null]} numberOfLines={1}>{value}</Text>
      <Text style={r.kpiLabel} numberOfLines={1}>{label}</Text>
      {sub ? <Text style={r.kpiSub} numberOfLines={1}>{sub}</Text> : null}
    </Card>
  );
}

const r = StyleSheet.create(scaleTextStyles({
  top: {flexDirection: 'row', alignItems: 'center', gap: 12},
  primary: {color: OB.text, fontFamily: BravoFont.bold, fontSize: 13.5},
  callSign: {color: OB.textMute, fontFamily: BravoFont.mono, fontSize: 11},
  status: {fontFamily: BravoFont.semiBold, fontSize: 11.5, marginTop: 2},
  time: {color: OB.text, fontFamily: BravoFont.bold, fontSize: 13},
  timeSub: {color: OB.textMute, fontFamily: BravoFont.mono, fontSize: 9.5, marginTop: 2},
  where: {flexDirection: 'row', alignItems: 'center', gap: 8},
  placeBtn: {
    flex: 1, minWidth: 0, minHeight: 40, flexDirection: 'row', alignItems: 'center', gap: 8,
    paddingHorizontal: 10, paddingVertical: 8, borderRadius: 11,
    backgroundColor: OB.accent + '14', borderWidth: 1, borderColor: OB.accent + '4D',
  },
  placeBtnOff: {backgroundColor: 'rgba(255,255,255,0.03)', borderColor: 'rgba(255,255,255,0.08)'},
  placeText: {flex: 1, minWidth: 0, color: OB.accentSoft, fontFamily: BravoFont.semiBold, fontSize: 12, lineHeight: 16},
  photoBtn: {
    minHeight: 40, flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 12,
    borderRadius: 11, backgroundColor: 'rgba(255,255,255,0.04)', borderWidth: 1, borderColor: 'rgba(255,255,255,0.12)',
  },
  photoText: {color: OB.textDim, fontFamily: BravoFont.semiBold, fontSize: 12},
  kpi: {flexBasis: '47%', flexGrow: 1, paddingVertical: 14, paddingHorizontal: 14},
  kpiValue: {color: OB.text, fontFamily: BravoFont.extraBold, fontSize: 22, letterSpacing: -0.5},
  kpiLabel: {color: OB.textMute, fontFamily: BravoFont.mono, fontSize: 9, letterSpacing: 1, textTransform: 'uppercase', marginTop: 4},
  kpiSub: {color: OB.textDim, fontFamily: BravoFont.regular, fontSize: 10.5, marginTop: 2},
}));
