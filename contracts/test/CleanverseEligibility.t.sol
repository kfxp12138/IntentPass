// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;
import {CleanverseEligibility} from "../src/CleanverseEligibility.sol";

// Explicit local interface doubles, not official CVI/CVA or qualification evidence.
contract CleanverseAssetDouble {
    address public policy;
    constructor(address p){policy=p;}
    function replacePolicy(address p) external {policy=p;}
}
contract CleanverseValidatorDouble {
    address public pool;
    bool public registered=true;
    bool public unavailable;
    mapping(address=>bool) public qualified;
    constructor(address p){pool=p;}
    function configure(address who,bool allowed,bool enrolled,bool failed) external {qualified[who]=allowed;registered=enrolled;unavailable=failed;}
    function isRegistered(address p) external view returns(bool){require(!unavailable);return registered&&p==pool;}
    function complianceVerify(address p,address user) external view returns(bool){require(!unavailable);return p==pool&&qualified[user];}
}
contract CleanversePolicyDouble {
    address public asset;address public from;address public to;uint256 public amount;
    bool public allowed=true;bool public unavailable;
    function configure(address a,address f,address t,uint256 n,bool permit,bool failed) external {asset=a;from=f;to=t;amount=n;allowed=permit;unavailable=failed;}
    function canTransfer(address a,address f,address t,uint256 n) external view returns(bool){require(!unavailable);return allowed&&a==asset&&f==from&&t==to&&n==amount;}
}
contract CleanverseMalformedDouble {
    uint256 public size=32;uint256 public value=2;
    function configure(uint256 s,uint256 v) external {size=s;value=v;}
    fallback() external {uint256 s=size;uint256 v=value;assembly{mstore(0,v)return(0,s)}}
}
interface CleanverseVm {function expectRevert(bytes4) external;}
contract CleanverseEligibilityTest {
    CleanverseVm constant vm=CleanverseVm(address(uint160(uint256(keccak256("hevm cheat code")))));
    address constant POOL=address(0x100);address constant BUYER=address(0x101);address constant PAYEE=address(0x102);
    CleanversePolicyDouble policy;CleanverseAssetDouble asset;CleanverseValidatorDouble validator;CleanverseEligibility gate;
    function setUp() public {
        policy=new CleanversePolicyDouble();asset=new CleanverseAssetDouble(address(policy));validator=new CleanverseValidatorDouble(POOL);
        for(uint256 i=0;i<3;i++)validator.configure(address(uint160(0x100+i)),true,true,false);
        gate=new CleanverseEligibility(address(asset),address(validator),address(policy),POOL);
        policy.configure(address(asset),BUYER,POOL,10,true,false);
    }
    function allowed(address from,address to,uint256 amount) private view returns(bool){return gate.canTransfer(address(asset),from,to,amount,keccak256("original-escrow-context"));}
    function testCleanversePreservesFundingAndWithdrawalSubjectsAndExactAmount() public {
        require(allowed(BUYER,POOL,10));require(!allowed(BUYER,POOL,11));
        policy.configure(address(asset),POOL,PAYEE,10,true,false);
        require(allowed(POOL,PAYEE,10));require(!allowed(POOL,BUYER,10));
    }
    function testCleanverseRequiresPoolRegistrationAndBothQualifiedParticipants() public {
        validator.configure(BUYER,true,false,false);require(!allowed(BUYER,POOL,10));
        validator.configure(BUYER,false,true,false);require(!allowed(BUYER,POOL,10));
        validator.configure(BUYER,true,true,false);validator.configure(POOL,false,true,false);require(!allowed(BUYER,POOL,10));
        validator.configure(POOL,true,true,false);policy.configure(address(asset),POOL,PAYEE,10,true,false);validator.configure(PAYEE,false,true,false);require(!allowed(POOL,PAYEE,10));
    }
    function testCleanverseRequiresCurrentAssetPolicyAndTransferPermission() public {
        policy.configure(address(asset),BUYER,POOL,10,false,false);require(!allowed(BUYER,POOL,10));
        policy.configure(address(asset),BUYER,POOL,10,true,false);asset.replacePolicy(address(validator));require(!allowed(BUYER,POOL,10));
    }
    function testCleanverseRejectsOtherAssetZeroEndpointsAndUnrelatedTransfers() public view {
        require(!gate.canTransfer(address(policy),BUYER,POOL,10,bytes32(0)));
        require(!allowed(address(0),POOL,10));require(!allowed(POOL,address(0),10));require(!allowed(BUYER,POOL,0));require(!allowed(BUYER,PAYEE,10));
    }
    function testCleanverseUnavailableValidatorOrPolicyCannotAllowTransfer() public {
        validator.configure(BUYER,true,true,true);require(!allowed(BUYER,POOL,10));validator.configure(BUYER,true,true,false);
        policy.configure(address(asset),BUYER,POOL,10,true,true);require(!allowed(BUYER,POOL,10));
    }
    function testCleanverseMalformedOfficialResponsesFailClosed() public {
        CleanverseMalformedDouble malformed=new CleanverseMalformedDouble();
        CleanverseEligibility bad=new CleanverseEligibility(address(asset),address(malformed),address(policy),POOL);
        for(uint256 i=0;i<3;i++){malformed.configure(i==0?0:i==1?31:64,1);require(!bad.canTransfer(address(asset),BUYER,POOL,10,bytes32(0)));}
        malformed.configure(32,2);require(!bad.canTransfer(address(asset),BUYER,POOL,10,bytes32(0)));
        bad=new CleanverseEligibility(address(malformed),address(validator),address(policy),POOL);
        malformed.configure(32,uint256(uint160(address(policy)))+(uint256(1)<<160));require(!bad.canTransfer(address(malformed),BUYER,POOL,10,bytes32(0)));
    }
    function testCleanverseConstructorRejectsMissingCodeOrZeroPool() public {
        vm.expectRevert(CleanverseEligibility.InvalidConfiguration.selector);new CleanverseEligibility(address(0),address(validator),address(policy),POOL);
        vm.expectRevert(CleanverseEligibility.InvalidConfiguration.selector);new CleanverseEligibility(address(asset),address(0),address(policy),POOL);
        vm.expectRevert(CleanverseEligibility.InvalidConfiguration.selector);new CleanverseEligibility(address(asset),address(validator),address(0),POOL);
        vm.expectRevert(CleanverseEligibility.InvalidConfiguration.selector);new CleanverseEligibility(address(asset),address(validator),address(policy),address(0));
        require(POOL.code.length==0);require(gate.pool()==POOL);
    }
    function testFuzzCleanversePassesOnlyExactPolicyAmount(uint256 amount) public {
        policy.configure(address(asset),BUYER,POOL,amount,true,false);require(allowed(BUYER,POOL,amount)==(amount!=0));
    }
}
