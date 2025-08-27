import { NgModule } from '@angular/core';
import { CommonModule } from '@angular/common';

@NgModule({
  declarations: [],
  imports: [
    CommonModule
  ],
  providers: [
    // StompClientService is provided in root, so no need to provide here
  ],
  exports: []
})
export class StompClientModule { }
