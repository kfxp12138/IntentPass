// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;
import {ContextVoteEscrow as Escrow} from "../src/ContextVoteEscrow.sol";
import {IntentHash} from "../src/IntentHash.sol";
import {AuthorizationHash as H} from "../src/AuthorizationHash.sol";
import {TestAsset,TestEligibility} from "./TestDoubles.sol";
interface EscrowVm {
    function addr(uint256) external pure returns(address);
    function sign(uint256,bytes32) external pure returns(uint8,bytes32,bytes32);
    function prank(address) external;
    function warp(uint256) external;
    function expectRevert() external;
    function expectRevert(bytes4) external;
}
contract ContextVoteEscrowTest {
    EscrowVm constant vm=EscrowVm(address(uint160(uint256(keccak256("hevm cheat code")))));
    // Isolated local test identities only. No actual wallet private keys.
    uint256 constant BUYER_KEY=0xa11ce;uint256 constant SELLER_KEY=0xb0b;uint256 constant REVIEW_KEY=0xcafe;
    address buyer;address seller;address reviewer;address executor=address(0xe);
    address[3] members;
    TestAsset token;TestEligibility gate;Escrow escrow;
    bytes32 constant ID=keccak256("local-order");
    struct Request {IntentHash.Envelope e;H.Receipt r;H.Grant g;H.Quote q;bytes rs;bytes gs;bytes qs;}
    function setUp() public {
        vm.warp(1000);buyer=vm.addr(BUYER_KEY);seller=vm.addr(SELLER_KEY);reviewer=vm.addr(REVIEW_KEY);
        members=[vm.addr(101),vm.addr(102),vm.addr(103)];token=new TestAsset();gate=new TestEligibility();
        escrow=new Escrow(address(token),address(gate),reviewer,members);token.mint(buyer,1_000_000);
        vm.prank(buyer);token.approve(address(escrow),type(uint256).max);
    }
    function signature(uint256 key,bytes32 hash) internal pure returns(bytes memory) {
        (uint8 v,bytes32 r,bytes32 s)=vm.sign(key,hash);return abi.encodePacked(r,s,v);
    }
    function request(uint256 price,uint256 bond) internal view returns(Request memory x) {
        x.e.schemaVersion=1;x.e.chainId=block.chainid;x.e.arbiter=address(escrow);x.e.orderId=ID;
        x.e.taskId=keccak256("task");x.e.attempt=1;x.e.buyer=buyer;x.e.seller=seller;x.e.payee=seller;
        x.e.asset=address(token);x.e.price=price;x.e.bond=bond;x.e.datasetHash=keccak256("[3,7,11,19]");
        x.e.serviceTermsHash=keccak256("Commercial use of current report allowed.");x.e.purchaseEvidenceCommitment=keccak256("local-test-evidence");
        x.e.policyHash=keccak256("local-test-policy");x.e.reviewer=reviewer;x.e.committeeHash=escrow.committeeHash();x.e.threshold=2;
        x.e.deliverySchemaHash=escrow.DELIVERY_SCHEMA();x.e.deliveryDeadline=2000;x.e.settlementDeadline=3000;
        x.e.allocationPolicyHash=escrow.ALLOCATION_POLICY();x.e.intentReleasePolicyHash=escrow.RELEASE_POLICY();
        bytes32 context=IntentHash.contextHash(x.e);
        x.r=H.Receipt(1,context,x.e.purchaseEvidenceCommitment,x.e.policyHash,reviewer,keccak256("LOCAL_TEST_ONLY"),keccak256("questions"),keccak256("PASS"),1900);
        bytes32 rh=H.signingHash("IntentPass.Receipt",block.chainid,address(escrow),H.receiptHash(x.r));
        x.g=H.Grant(1,buyer,executor,block.chainid,address(escrow),ID,address(token),price+bond,context,escrow.preparationHash(context),rh,0,1900,1);
        x.q=H.Quote(1,keccak256("quote"),keccak256("dataset-report"),seller,seller,address(token),price,x.e.serviceTermsHash,1900);
        x.rs=signature(REVIEW_KEY,rh);x.gs=signature(BUYER_KEY,H.signingHash("IntentPass.Grant",block.chainid,address(escrow),H.grantHash(x.g)));
        x.qs=signature(SELLER_KEY,H.signingHash("IntentPass.Quote",block.chainid,address(escrow),H.quoteHash(x.q)));
    }
    function submit(Request memory x) internal {vm.prank(executor);escrow.submit(x.e,x.r,x.rs,x.g,x.gs,x.q,x.qs);}
    function evidence() internal view returns(bytes32 h) {(,,,,,,,,,,h,,)=escrow.orders(ID);}
    function state() internal view returns(Escrow.State s) {(,,,,,,,,,,,,s)=escrow.orders(ID);}
    function deliver() internal {
        vm.prank(seller);escrow.deliver(Escrow.Delivery(1,ID,keccak256("[3,7,11,19]"),keccak256("report"),keccak256("Commercial use of current report allowed.")));
    }
    function approve(uint256 index) internal {
        bytes32 h=evidence();escrow.accept(ID,h,2900,index,signature(101+index,escrow.voteDigest(ID,h,2900)));
    }
    function certify() internal {deliver();approve(0);approve(1);}
    function conserved() internal view {require(token.balanceOf(address(escrow))==escrow.locked()+escrow.outstanding(),"funds not conserved");}
    function testNormalFundsAndWithdrawals() public {
        submit(request(10,2));require(token.balanceOf(buyer)==999988);conserved();certify();escrow.settle(ID);
        require(state()==Escrow.State.ALLOCATED_PAID);require(escrow.credits(ID,seller)==10);require(escrow.credits(ID,buyer)==2);conserved();
        vm.prank(seller);escrow.withdraw(ID);vm.prank(buyer);escrow.withdraw(ID);
        require(token.balanceOf(seller)==10 && token.balanceOf(buyer)==999990);require(escrow.withdrawn(ID,seller)==10);conserved();
    }
    function testRefundWithoutDelivery() public {submit(request(10,2));vm.warp(3001);escrow.timeout(ID);require(state()==Escrow.State.ALLOCATED_REFUND);require(escrow.credits(ID,buyer)==12);vm.prank(buyer);escrow.withdraw(ID);require(token.balanceOf(buyer)==1_000_000);conserved();}
    function testRefundWithoutThreshold() public {submit(request(10,2));deliver();approve(0);vm.warp(3001);escrow.timeout(ID);require(escrow.credits(ID,buyer)==12);require(escrow.credits(ID,seller)==0);conserved();}
    function testCertifiedTimeoutCompensation() public {submit(request(10,2));certify();vm.warp(3001);escrow.timeout(ID);require(state()==Escrow.State.ALLOCATED_COMPENSATION);require(escrow.credits(ID,buyer)==10);require(escrow.credits(ID,seller)==2);conserved();}
    function testZeroBondNormalAndTimeout() public {submit(request(10,0));certify();escrow.settle(ID);require(escrow.credits(ID,buyer)==0);require(escrow.credits(ID,seller)==10);conserved();}
    function testLegacyCalldataCannotFund() public {
        vm.prank(executor);(bool ok,)=address(escrow).call(abi.encodeWithSignature("fundOrder(bytes32)",ID));
        require(!ok);require(!escrow.consumed(buyer,0));require(escrow.locked()==0);require(token.balanceOf(buyer)==1_000_000);
    }
    function testVoteFromOtherDomainRejected() public {
        Request memory x=request(10,0);submit(x);deliver();bytes32 h=evidence();
        bytes32 vote=keccak256(abi.encode(escrow.VOTE_TYPE(),ID,IntentHash.contextHash(x.e),h,escrow.committeeHash(),uint256(2900)));
        bytes memory wrongChain=signature(101,H.signingHash("IntentPass.Acceptance",block.chainid+1,address(escrow),vote));
        bytes memory wrongArbiter=signature(101,H.signingHash("IntentPass.Acceptance",block.chainid,address(123),vote));
        vm.expectRevert(Escrow.InvalidSignature.selector);escrow.accept(ID,h,2900,0,wrongChain);
        vm.expectRevert(Escrow.InvalidSignature.selector);escrow.accept(ID,h,2900,0,wrongArbiter);
        require(state()==Escrow.State.EVIDENCE_FROZEN);conserved();
    }
    function testInvalidCommitteeIndexRejected() public {
        submit(request(10,0));deliver();bytes32 h=evidence();
        vm.expectRevert(Escrow.InvalidVote.selector);escrow.accept(ID,h,2900,3,"");
    }
    function testMissingOwnerSignature() public {Request memory x=request(10,0);x.gs="";vm.expectRevert(Escrow.InvalidSignature.selector);submit(x);require(!escrow.consumed(buyer,0));require(token.balanceOf(address(escrow))==0);}
    function testMissingReceiptSignature() public {Request memory x=request(10,0);x.rs="";vm.expectRevert(Escrow.InvalidSignature.selector);submit(x);}
    function testMissingQuoteSignature() public {Request memory x=request(10,0);x.qs="";vm.expectRevert(Escrow.InvalidSignature.selector);submit(x);}
    function testRejectNonPassReceipt() public {Request memory x=request(10,0);x.r.decisionHash=keccak256("ABSTAIN");vm.expectRevert(Escrow.ContextMismatch.selector);submit(x);}
    function testWrongExecutor() public {Request memory x=request(10,0);vm.expectRevert(Escrow.WrongExecutor.selector);escrow.submit(x.e,x.r,x.rs,x.g,x.gs,x.q,x.qs);}
    function testChangedPayee() public {Request memory x=request(10,0);x.e.payee=address(123);vm.expectRevert(Escrow.ContextMismatch.selector);submit(x);}
    function testChangedPrice() public {Request memory x=request(10,0);x.e.price=11;vm.expectRevert(Escrow.ContextMismatch.selector);submit(x);}
    function testChangedAsset() public {Request memory x=request(10,0);x.e.asset=address(123);vm.expectRevert(Escrow.ContextMismatch.selector);submit(x);}
    function testChangedCommittee() public {Request memory x=request(10,0);x.e.committeeHash=keccak256("other");vm.expectRevert(Escrow.ContextMismatch.selector);submit(x);}
    function testChangedEvidence() public {Request memory x=request(10,0);x.e.purchaseEvidenceCommitment=keccak256("other");vm.expectRevert(Escrow.ContextMismatch.selector);submit(x);}
    function testChangedPreparation() public {Request memory x=request(10,0);x.g.preparationHash=keccak256("other");vm.expectRevert(Escrow.ContextMismatch.selector);submit(x);}
    function testReplayRejected() public {Request memory x=request(10,0);submit(x);vm.expectRevert(Escrow.AlreadyConsumed.selector);submit(x);require(token.balanceOf(address(escrow))==10);conserved();}
    function testNonceCannotFundOtherOrder() public {
        Request memory x=request(10,0);submit(x);x.e.orderId=keccak256("another");vm.expectRevert(Escrow.AlreadyConsumed.selector);submit(x);conserved();
    }
    function testRevocationStopsUnusedGrant() public {Request memory x=request(10,0);vm.prank(buyer);escrow.revoke(0);vm.expectRevert(Escrow.AuthorizationRevoked.selector);submit(x);require(token.balanceOf(buyer)==1_000_000);}
    function testCannotRevokeFundedObligation() public {submit(request(10,0));vm.prank(buyer);vm.expectRevert(Escrow.AlreadyConsumed.selector);escrow.revoke(0);require(state()==Escrow.State.FUNDED);}
    function testReceiptExpiresForNewOrders() public {Request memory x=request(10,0);vm.warp(1901);vm.expectRevert(Escrow.Expired.selector);submit(x);}
    function testReceiptExpiryDoesNotCancelFundedOrder() public {submit(request(10,0));vm.warp(1901);certify();escrow.settle(ID);require(escrow.credits(ID,seller)==10);}
    function testIdentityBlocksDirectFunding() public {Request memory x=request(10,0);gate.deny(buyer,true);vm.expectRevert(Escrow.IdentityBlocked.selector);submit(x);require(!escrow.consumed(buyer,0));require(token.balanceOf(buyer)==1_000_000);}
    function testCustodyEligibilityRequired() public {Request memory x=request(10,0);gate.deny(address(escrow),true);vm.expectRevert(Escrow.IdentityBlocked.selector);submit(x);}
    function testGateUnavailableFailsClosed() public {Request memory x=request(10,0);gate.setUnavailable(true);vm.expectRevert();submit(x);require(escrow.locked()==0);}
    function testOneVoteCannotSettle() public {submit(request(10,0));deliver();approve(0);vm.expectRevert(Escrow.InvalidState.selector);escrow.settle(ID);conserved();}
    function testDuplicateMemberRejected() public {submit(request(10,0));deliver();approve(0);bytes32 h=evidence();bytes memory sig=signature(101,escrow.voteDigest(ID,h,2900));vm.expectRevert(Escrow.InvalidVote.selector);escrow.accept(ID,h,2900,0,sig);require(state()==Escrow.State.EVIDENCE_FROZEN);}
    function testDifferentEvidenceRejected() public {submit(request(10,0));deliver();bytes32 other=keccak256("other");bytes memory sig=signature(101,escrow.voteDigest(ID,other,2900));vm.expectRevert(Escrow.InvalidVote.selector);escrow.accept(ID,other,2900,0,sig);}
    function testWrongMemberSignatureRejected() public {submit(request(10,0));deliver();bytes32 h=evidence();bytes memory sig=signature(102,escrow.voteDigest(ID,h,2900));vm.expectRevert(Escrow.InvalidSignature.selector);escrow.accept(ID,h,2900,0,sig);}
    function testEvidenceFrozenCannotReplace() public {submit(request(10,0));deliver();vm.expectRevert(Escrow.InvalidState.selector);deliver();}
    function testWrongDeliveryDatasetRejected() public {submit(request(10,0));vm.prank(seller);vm.expectRevert(Escrow.InvalidDelivery.selector);escrow.deliver(Escrow.Delivery(1,ID,keccak256("wrong"),keccak256("report"),keccak256("Commercial use of current report allowed.")));}
    function testOnlySellerCanDeliver() public {submit(request(10,0));vm.expectRevert(Escrow.InvalidDelivery.selector);escrow.deliver(Escrow.Delivery(1,ID,keccak256("[3,7,11,19]"),keccak256("report"),keccak256("Commercial use of current report allowed.")));}
    function testDeliveryExpired() public {submit(request(10,0));vm.warp(2001);vm.expectRevert(Escrow.Expired.selector);deliver();}
    function testTimeoutCannotRunEarly() public {submit(request(10,0));vm.warp(3000);vm.expectRevert(Escrow.Expired.selector);escrow.timeout(ID);}
    function testTerminalStateCannotAllocateTwice() public {submit(request(10,0));certify();escrow.settle(ID);vm.expectRevert(Escrow.InvalidState.selector);escrow.settle(ID);vm.warp(3001);vm.expectRevert(Escrow.InvalidState.selector);escrow.timeout(ID);conserved();}
    function testWithdrawCannotRunTwiceOrByStranger() public {submit(request(10,0));certify();escrow.settle(ID);vm.expectRevert(Escrow.NoCredit.selector);escrow.withdraw(ID);vm.prank(seller);escrow.withdraw(ID);vm.prank(seller);vm.expectRevert(Escrow.NoCredit.selector);escrow.withdraw(ID);conserved();}
    function testIdentityChangeBlocksAllocationWithoutLosingFunds() public {submit(request(10,0));certify();gate.deny(seller,true);vm.expectRevert(Escrow.IdentityBlocked.selector);escrow.settle(ID);require(state()==Escrow.State.CERTIFIED);require(escrow.locked()==10);conserved();gate.deny(seller,false);escrow.settle(ID);conserved();}
    function testIdentityChangeBlocksRefund() public {submit(request(10,0));gate.deny(buyer,true);vm.warp(3001);vm.expectRevert(Escrow.IdentityBlocked.selector);escrow.timeout(ID);require(state()==Escrow.State.FUNDED);conserved();}
    function testIdentityChangeBlocksWithdrawAndRecoveryPreservesCredit() public {submit(request(10,0));certify();escrow.settle(ID);gate.deny(seller,true);vm.prank(seller);vm.expectRevert(Escrow.IdentityBlocked.selector);escrow.withdraw(ID);require(escrow.credits(ID,seller)==10);gate.deny(seller,false);vm.prank(seller);escrow.withdraw(ID);conserved();}
    function testFundingFailureRollsBackNonceAndOrder() public {Request memory x=request(10,0);token.setFailure(2);vm.expectRevert();submit(x);require(!escrow.consumed(buyer,0));require(state()==Escrow.State.UNREGISTERED);require(escrow.locked()==0);}
    function testFeeOnFundingRejected() public {Request memory x=request(10,0);token.setFailure(3);vm.expectRevert(Escrow.TransferAmountMismatch.selector);submit(x);require(!escrow.consumed(buyer,0));require(token.balanceOf(buyer)==1_000_000);}
    function testRevertTransferRetainsCredit() public {submit(request(10,0));certify();escrow.settle(ID);token.setFailure(1);vm.prank(seller);vm.expectRevert();escrow.withdraw(ID);require(escrow.credits(ID,seller)==10);require(escrow.withdrawn(ID,seller)==0);conserved();}
    function testFalseTransferRetainsCredit() public {submit(request(10,0));certify();escrow.settle(ID);token.setFailure(2);vm.prank(seller);vm.expectRevert();escrow.withdraw(ID);require(escrow.credits(ID,seller)==10);conserved();}
    function testFeeOnWithdrawRejectedWithoutLosingCredit() public {submit(request(10,0));certify();escrow.settle(ID);token.setFailure(3);vm.prank(seller);vm.expectRevert(Escrow.TransferAmountMismatch.selector);escrow.withdraw(ID);require(escrow.credits(ID,seller)==10);require(token.balanceOf(seller)==0);conserved();}
    function testAnyTwoCommitteeMembers() public {submit(request(10,0));deliver();approve(0);approve(2);require(state()==Escrow.State.CERTIFIED);}
    function testDuplicateCommitteeConstructorRejected() public {address[3] memory bad=[members[0],members[0],members[2]];vm.expectRevert(Escrow.InvalidConfiguration.selector);new Escrow(address(token),address(gate),reviewer,bad);}
    function testFuzzNormalConservation(uint64 p,uint64 b) public {uint256 price=uint256(p)%10000+1;uint256 bond=uint256(b)%10000;submit(request(price,bond));conserved();certify();escrow.settle(ID);conserved();if(bond!=0){vm.prank(buyer);escrow.withdraw(ID);}vm.prank(seller);escrow.withdraw(ID);require(token.balanceOf(buyer)==1_000_000-price);require(token.balanceOf(seller)==price);conserved();}
    function testFuzzRefundConservation(uint64 p,uint64 b) public {uint256 price=uint256(p)%10000+1;uint256 bond=uint256(b)%10000;submit(request(price,bond));vm.warp(3001);escrow.timeout(ID);vm.prank(buyer);escrow.withdraw(ID);require(token.balanceOf(buyer)==1_000_000);conserved();}
    function testFuzzCompensationConservation(uint64 p,uint64 b) public {uint256 price=uint256(p)%10000+1;uint256 bond=uint256(b)%10000;submit(request(price,bond));certify();vm.warp(3001);escrow.timeout(ID);vm.prank(buyer);escrow.withdraw(ID);if(bond!=0){vm.prank(seller);escrow.withdraw(ID);}require(token.balanceOf(buyer)==1_000_000-bond);require(token.balanceOf(seller)==bond);conserved();}
}
