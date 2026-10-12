/* Thin stdin-only bridge to pinned libsecp256k1-zkp. No curve arithmetic here.
 * Experimental, local review certificates only. Never use wallet/ECDH keys. */
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <secp256k1.h>
#include <secp256k1_ecdsa_adaptor.h>
#include <secp256k1_recovery.h>

static void wipe(void *p, size_t n) { volatile unsigned char *v=p; while(n--) *v++=0; }
static int nibble(char c) { if(c>='0'&&c<='9')return c-'0'; if(c>='a'&&c<='f')return c-'a'+10; if(c>='A'&&c<='F')return c-'A'+10; return -1; }
static int decode(const char *s,unsigned char *out,size_t n) {
  if(!s||strlen(s)!=2*n)return 0;
  for(size_t i=0;i<n;i++){int a=nibble(s[2*i]),b=nibble(s[2*i+1]);if(a<0||b<0)return 0;out[i]=(unsigned char)(16*a+b);}return 1;
}
static void emit(const unsigned char *b,size_t n){for(size_t i=0;i<n;i++)printf("%02x",b[i]);puts("");}
static int serial(secp256k1_context *ctx,unsigned char out[33],const secp256k1_pubkey *pk){size_t n=33;return secp256k1_ec_pubkey_serialize(ctx,out,&n,pk,SECP256K1_EC_COMPRESSED);}
int main(int argc,char **argv){
  (void)argv;
  char line[2048]={0},*args[8]={0};size_t count=0;
  unsigned char key[32]={0},msg[32]={0},point[33]={0},pub[33]={0},pre[162]={0},sig[65]={0},entropy[32]={0},aux[32]={0};
  secp256k1_pubkey P,Y,K;secp256k1_ecdsa_signature signature;int ok=0;
  secp256k1_context *ctx=NULL;
  if(argc!=1||!fgets(line,sizeof(line),stdin)||!strchr(line,'\n')||fgetc(stdin)!=EOF)goto done;
  for(char *t=strtok(line," \r\n");t;t=strtok(NULL," \r\n")){if(count==8)goto done;args[count++]=t;}
  if(count<2)goto done;
  ctx=secp256k1_context_create(SECP256K1_CONTEXT_NONE);
  FILE *rng=fopen("/dev/urandom","rb");if(!rng)goto done;size_t read=fread(entropy,1,32,rng);fclose(rng);
  if(read!=32||!secp256k1_context_randomize(ctx,entropy))goto done;
  if(!strcmp(args[0],"pub")&&count==2){
    if(!decode(args[1],key,32)||!secp256k1_ec_pubkey_create(ctx,&P,key)||!serial(ctx,pub,&P))goto done;
    emit(pub,33);ok=1;
  }else if(!strcmp(args[0],"presign")&&count==5){
    if(!decode(args[1],key,32)||!decode(args[2],msg,32)||!decode(args[3],point,33)||!decode(args[4],aux,32)
      ||!secp256k1_ec_seckey_verify(ctx,key)||!secp256k1_ec_pubkey_parse(ctx,&Y,point,33))goto done;
    if(!secp256k1_ecdsa_adaptor_encrypt(ctx,pre,key,&Y,msg,NULL,aux))goto done;
    emit(pre,162);ok=1;
  }else if((!strcmp(args[0],"verify")&&count==5)||(!strcmp(args[0],"complete")&&count==6)){
    if(!decode(args[1],pub,33)||!decode(args[2],msg,32)||!decode(args[3],point,33)||!decode(args[4],pre,162)
      ||!secp256k1_ec_pubkey_parse(ctx,&P,pub,33)||!secp256k1_ec_pubkey_parse(ctx,&Y,point,33))goto done;
    int valid=secp256k1_ecdsa_adaptor_verify(ctx,pre,&P,msg,&Y);
    if(!strcmp(args[0],"verify")){puts(valid?"1":"0");ok=1;goto done;}
    unsigned char expected[33];
    if(!valid||!decode(args[5],key,32)||!secp256k1_ec_pubkey_create(ctx,&K,key)||!serial(ctx,expected,&K)||memcmp(expected,point,33))goto done;
    if(!secp256k1_ecdsa_adaptor_decrypt(ctx,&signature,key,pre)||!secp256k1_ecdsa_verify(ctx,&signature,msg,&P)
      ||!secp256k1_ecdsa_signature_serialize_compact(ctx,sig,&signature))goto done;
    for(int recid=0;recid<2;recid++){
      secp256k1_ecdsa_recoverable_signature recovered;
      if(secp256k1_ecdsa_recoverable_signature_parse_compact(ctx,&recovered,sig,recid)&&secp256k1_ecdsa_recover(ctx,&K,&recovered,msg)&&serial(ctx,expected,&K)&&!memcmp(expected,pub,33)){
        sig[64]=(unsigned char)(27+recid);emit(sig,65);ok=1;break;
      }
    }
  }else if(!strcmp(args[0],"extract")&&count==4){
    if(!decode(args[1],point,33)||!decode(args[2],pre,162)||!decode(args[3],sig,64)
      ||!secp256k1_ec_pubkey_parse(ctx,&Y,point,33)||!secp256k1_ecdsa_signature_parse_compact(ctx,&signature,sig)
      ||!secp256k1_ecdsa_adaptor_recover(ctx,key,&signature,pre,&Y))goto done;
    emit(key,32);ok=1;
  }
done:
  wipe(line,sizeof(line));wipe(key,sizeof(key));wipe(entropy,sizeof(entropy));wipe(aux,sizeof(aux));
  if(ctx)secp256k1_context_destroy(ctx);
  if(!ok)fputs("ADAPTOR_OPERATION_INVALID\n",stderr);
  return ok?0:1;
}
