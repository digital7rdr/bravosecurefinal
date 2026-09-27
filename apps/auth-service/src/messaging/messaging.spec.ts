import {MessagingService} from './messaging.service';
import {SmsService} from '../common/services/sms.service';
import {CATALOG_BY_KEY, CATALOG_CATEGORIES} from '../settings/settings-catalog';
import type {SettingsService} from '../settings/settings.service';
import type {ConfigService} from '@nestjs/config';

function messaging(values: Record<string, string>): MessagingService {
  return new MessagingService({getSync: (k: string) => values[k]} as unknown as SettingsService);
}

const TW_VERIFY = {'twilio.accountSid': 'AC1', 'twilio.authToken': 't', 'twilio.verifySid': 'VA1'};
const TW_SMS = {'twilio.accountSid': 'AC1', 'twilio.authToken': 't', 'twilio.fromNumber': '+1999'};

describe('MessagingService — OTP mode', () => {
  it('unset → original inference: Verify first, then SMS, else none', () => {
    expect(messaging(TW_VERIFY).otpMode()).toBe('verify');
    expect(messaging({...TW_VERIFY, ...TW_SMS}).otpMode()).toBe('verify');
    expect(messaging(TW_SMS).otpMode()).toBe('sms');
    expect(messaging({}).otpMode()).toBeNull();
  });

  it('an explicit choice wins; junk values fall back to the inference', () => {
    expect(messaging({...TW_VERIFY, ...TW_SMS, 'twilio.otpMode': 'sms'}).otpMode()).toBe('sms');
    expect(messaging({...TW_VERIFY, 'twilio.otpMode': 'carrier-pigeon'}).otpMode()).toBe('verify');
  });

  it('sendSms without a From number refuses before touching Twilio', async () => {
    await expect(messaging(TW_VERIFY).sendSms('+971500000000', 'x')).rejects.toThrow(/Twilio SMS not configured/);
  });
});

describe('settings catalog — Twilio only', () => {
  it('offers exactly the two OTP modes the service understands', () => {
    expect(CATALOG_BY_KEY.get('twilio.otpMode')!.options!.map(o => o.value).sort()).toEqual(['sms', 'verify']);
  });

  it('no WhatsApp / Unifonic settings remain', () => {
    const keys = [...CATALOG_BY_KEY.keys()];
    expect(keys.filter(k => /whatsapp|unifonic|^messaging\./.test(k))).toEqual([]);
    expect(CATALOG_CATEGORIES.map(c => c.id)).toEqual(['stripe', 'twilio', 'mapbox', 'biometric']);
  });
});

describe('SmsService', () => {
  const cfg = (o: Record<string, unknown> = {}) => ({get: (k: string) => o[k]}) as unknown as ConfigService;

  it('sends through Twilio and never throws', async () => {
    const m = messaging(TW_SMS);
    const spy = jest.spyOn(m, 'sendSms').mockResolvedValueOnce({}).mockRejectedValueOnce(new Error('down'));
    const sms = new SmsService(cfg(), m);
    await expect(sms.sendSms('+971500000000', 'x')).resolves.toEqual({sent: true});
    expect(spy).toHaveBeenCalledWith('+971500000000', 'x');
    await expect(sms.sendSms('+971500000000', 'x')).resolves.toEqual({sent: false});
  });

  it('no Twilio SMS credentials → not sent; dev bypass → not sent, no Twilio call', async () => {
    const m = messaging({});
    const spy = jest.spyOn(m, 'sendSms');
    await expect(new SmsService(cfg(), m).sendSms('+971500000000', 'x')).resolves.toEqual({sent: false});
    const m2 = messaging(TW_SMS);
    const spy2 = jest.spyOn(m2, 'sendSms');
    await expect(new SmsService(cfg({'otp.devBypass': true}), m2).sendSms('+971500000000', 'x')).resolves.toEqual({sent: false});
    expect(spy).not.toHaveBeenCalled();
    expect(spy2).not.toHaveBeenCalled();
  });
});
