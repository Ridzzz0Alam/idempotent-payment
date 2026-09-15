import { IsInt, IsPositive, IsString, Length } from "class-validator";

export class CreatePaymentDto {
  @IsInt()
  @IsPositive()
  amount!: number;

  @IsString()
  @Length(3, 3)
  currency!: string;

  @IsString()
  @Length(1, 200)
  reference!: string;
}
