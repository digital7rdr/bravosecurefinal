import {Global, Module} from '@nestjs/common';
import {MessagingService} from './messaging.service';

/**
 * Twilio credentials + OTP mode resolution. Global so OtpService and
 * SmsService — provided locally by several feature modules — can inject
 * MessagingService without each module importing this one.
 */
@Global()
@Module({
  providers: [MessagingService],
  exports: [MessagingService],
})
export class MessagingModule {}
