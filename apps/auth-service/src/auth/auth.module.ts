import {Module} from '@nestjs/common';
import {AuthController}  from './auth.controller';
import {AuthService}     from './auth.service';
import {JwtService}      from './jwt.service';
import {PasswordService} from '../common/services/password.service';
import {OtpService}      from '../common/services/otp.service';
import {JwtAuthGuard}    from '../common/guards/jwt-auth.guard';

@Module({
  controllers: [AuthController],
  providers:   [AuthService, JwtService, PasswordService, OtpService, JwtAuthGuard],
  exports:     [AuthService, JwtService, JwtAuthGuard],
})
export class AuthModule {}
