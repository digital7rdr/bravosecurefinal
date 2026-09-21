import {Module} from '@nestjs/common';
import {TotpController}  from './totp.controller';
import {TotpService}     from './totp.service';
import {AuthModule}      from '../auth/auth.module';
import {TotpCryptoService} from '../common/services/totp-crypto.service';

@Module({
  imports:     [AuthModule],
  controllers: [TotpController],
  providers:   [TotpService, TotpCryptoService],
})
export class TotpModule {}
