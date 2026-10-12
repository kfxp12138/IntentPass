// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {ContextVoteEscrow as Escrow} from "../src/ContextVoteEscrow.sol";
import {IntentHash} from "../src/IntentHash.sol";
import {AuthorizationHash as H} from "../src/AuthorizationHash.sol";
import {IntentPassDemoToken} from "../src/IntentPassDemoToken.sol";
import {FixedAssetEligibility} from "../src/FixedAssetEligibility.sol";

interface DemoEscrowVm {
    function addr(uint256) external pure returns (address);
    function sign(uint256, bytes32) external pure returns (uint8, bytes32, bytes32);
    function prank(address) external;
    function warp(uint256) external;
    function expectRevert(bytes4) external;
}

/// @dev Uses the deployable demo token and fixed-asset gate, without Cleanverse or mutable test doubles.
contract DemoAssetEscrowTest {
    DemoEscrowVm constant vm = DemoEscrowVm(address(uint160(uint256(keccak256("hevm cheat code")))));
    // Isolated local test identities only. These are not actual wallet keys.
    uint256 constant BUYER_KEY = 0xa11ce;
    uint256 constant SELLER_KEY = 0xb0b;
    uint256 constant REVIEW_KEY = 0xcafe;
    uint256 constant PRICE = 10e6;
    uint256 constant BOND = 2e6;
    bytes32 constant ORDER_ID = keccak256("demo-asset-local-order");
    address buyer;
    address seller;
    address reviewer;
    address constant EXECUTOR = address(0xe);
    address[3] members;
    IntentPassDemoToken token;
    FixedAssetEligibility gate;
    Escrow escrow;

    struct Request {
        IntentHash.Envelope envelope;
        H.Receipt receipt;
        H.Grant grant;
        H.Quote quote;
        bytes receiptSignature;
        bytes grantSignature;
        bytes quoteSignature;
    }

    function setUp() public {
        vm.warp(1000);
        buyer = vm.addr(BUYER_KEY);
        seller = vm.addr(SELLER_KEY);
        reviewer = vm.addr(REVIEW_KEY);
        members = [vm.addr(101), vm.addr(102), vm.addr(103)];
        token = new IntentPassDemoToken(buyer);
        gate = new FixedAssetEligibility(address(token));
        escrow = new Escrow(address(token), address(gate), reviewer, members);
    }

    function signature(uint256 key, bytes32 digest) private pure returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(key, digest);
        return abi.encodePacked(r, s, v);
    }

    function request() private view returns (Request memory x) {
        x.envelope.schemaVersion = 1;
        x.envelope.chainId = block.chainid;
        x.envelope.arbiter = address(escrow);
        x.envelope.orderId = ORDER_ID;
        x.envelope.taskId = keccak256("demo-task");
        x.envelope.attempt = 1;
        x.envelope.buyer = buyer;
        x.envelope.seller = seller;
        x.envelope.payee = seller;
        x.envelope.asset = address(token);
        x.envelope.price = PRICE;
        x.envelope.bond = BOND;
        x.envelope.datasetHash = keccak256("[3,7,11,19]");
        x.envelope.serviceTermsHash = keccak256("Commercial use of current report allowed.");
        x.envelope.purchaseEvidenceCommitment = keccak256("local-demo-test-evidence");
        x.envelope.policyHash = keccak256("local-demo-test-policy");
        x.envelope.reviewer = reviewer;
        x.envelope.committeeHash = escrow.committeeHash();
        x.envelope.threshold = 2;
        x.envelope.deliverySchemaHash = escrow.DELIVERY_SCHEMA();
        x.envelope.deliveryDeadline = 2000;
        x.envelope.settlementDeadline = 3000;
        x.envelope.allocationPolicyHash = escrow.ALLOCATION_POLICY();
        x.envelope.intentReleasePolicyHash = escrow.RELEASE_POLICY();
        bytes32 context = IntentHash.contextHash(x.envelope);
        x.receipt = H.Receipt(1, context, x.envelope.purchaseEvidenceCommitment, x.envelope.policyHash,
            reviewer, keccak256("LOCAL_TEST_ONLY"), keccak256("questions"), keccak256("PASS"), 1900);
        bytes32 receiptDigest = H.signingHash("IntentPass.Receipt", block.chainid, address(escrow), H.receiptHash(x.receipt));
        x.grant = H.Grant(1, buyer, EXECUTOR, block.chainid, address(escrow), ORDER_ID, address(token), PRICE + BOND,
            context, escrow.preparationHash(context), receiptDigest, 0, 1900, 1);
        x.quote = H.Quote(1, keccak256("demo-quote"), keccak256("dataset-report"), seller, seller,
            address(token), PRICE, x.envelope.serviceTermsHash, 1900);
        x.receiptSignature = signature(REVIEW_KEY, receiptDigest);
        x.grantSignature = signature(BUYER_KEY, H.signingHash("IntentPass.Grant", block.chainid, address(escrow), H.grantHash(x.grant)));
        x.quoteSignature = signature(SELLER_KEY, H.signingHash("IntentPass.Quote", block.chainid, address(escrow), H.quoteHash(x.quote)));
    }

    function approveFunding() private {
        vm.prank(buyer);
        require(token.approve(address(escrow), PRICE + BOND));
    }

    function submit(Request memory x) private {
        vm.prank(EXECUTOR);
        escrow.submit(x.envelope, x.receipt, x.receiptSignature, x.grant, x.grantSignature, x.quote, x.quoteSignature);
    }

    function fund() private {
        approveFunding();
        submit(request());
    }

    function state() private view returns (Escrow.State orderState) {
        (,,,,,,,,,,,,orderState) = escrow.orders(ORDER_ID);
    }

    function certify() private {
        vm.prank(seller);
        escrow.deliver(Escrow.Delivery(1, ORDER_ID, keccak256("[3,7,11,19]"), keccak256("report"),
            keccak256("Commercial use of current report allowed.")));
        bytes32 evidence;
        (,,,,,,,,,,evidence,,) = escrow.orders(ORDER_ID);
        escrow.accept(ORDER_ID, evidence, 2900, 0, signature(101, escrow.voteDigest(ORDER_ID, evidence, 2900)));
        vm.expectRevert(Escrow.InvalidState.selector);
        escrow.settle(ORDER_ID);
        escrow.accept(ORDER_ID, evidence, 2900, 1, signature(102, escrow.voteDigest(ORDER_ID, evidence, 2900)));
    }

    function conserved() private view {
        require(token.balanceOf(address(escrow)) == escrow.locked() + escrow.outstanding(), "escrow funds not conserved");
        require(token.totalSupply() == token.INITIAL_SUPPLY(), "token supply changed");
    }

    function unfunded() private view {
        require(!escrow.consumed(buyer, 0), "unauthorized nonce consumption");
        require(token.balanceOf(buyer) == token.INITIAL_SUPPLY(), "unauthorized buyer debit");
        require(escrow.locked() == 0 && token.balanceOf(address(escrow)) == 0, "unauthorized funding");
        conserved();
    }

    function testDemoFundingUsesBuyerAssetsAndConsumesExactApproval() public {
        fund();
        require(escrow.consumed(buyer, 0), "grant not consumed");
        require(token.balanceOf(buyer) == token.INITIAL_SUPPLY() - PRICE - BOND, "wrong buyer debit");
        require(token.balanceOf(address(escrow)) == PRICE + BOND, "wrong escrow credit");
        require(token.balanceOf(EXECUTOR) == 0, "executor became funding source");
        require(token.allowance(buyer, address(escrow)) == 0, "approval not exhausted");
        require(state() == Escrow.State.FUNDED, "wrong order state");
        conserved();
    }

    function testFixedGateDoesNotReplaceOwnerSignature() public {
        approveFunding();
        Request memory x = request();
        x.grantSignature = "";
        vm.expectRevert(Escrow.InvalidSignature.selector);
        submit(x);
        unfunded();
    }

    function testFixedGateDoesNotReplaceExecutorRestriction() public {
        approveFunding();
        Request memory x = request();
        vm.expectRevert(Escrow.WrongExecutor.selector);
        escrow.submit(x.envelope, x.receipt, x.receiptSignature, x.grant, x.grantSignature, x.quote, x.quoteSignature);
        unfunded();
    }

    function testRevokedDemoGrantCannotFund() public {
        approveFunding();
        Request memory x = request();
        vm.prank(buyer);
        escrow.revoke(0);
        vm.expectRevert(Escrow.AuthorizationRevoked.selector);
        submit(x);
        unfunded();
    }

    function testDemoGrantCanFundOnlyOnce() public {
        Request memory x = request();
        approveFunding();
        submit(x);
        vm.expectRevert(Escrow.AlreadyConsumed.selector);
        submit(x);
        require(token.balanceOf(buyer) == token.INITIAL_SUPPLY() - PRICE - BOND, "second buyer debit");
        require(token.balanceOf(address(escrow)) == PRICE + BOND, "duplicate funding");
        conserved();
    }

    function testDemoRefundRestoresBuyerAndCannotAllocateOrWithdrawTwice() public {
        fund();
        vm.warp(3001);
        escrow.timeout(ORDER_ID);
        require(state() == Escrow.State.ALLOCATED_REFUND, "wrong refund state");
        require(escrow.credits(ORDER_ID, buyer) == PRICE + BOND && escrow.credits(ORDER_ID, seller) == 0, "wrong refund allocation");
        conserved();
        vm.prank(buyer);
        escrow.withdraw(ORDER_ID);
        require(token.balanceOf(buyer) == token.INITIAL_SUPPLY(), "buyer refund incomplete");
        require(escrow.withdrawn(ORDER_ID, buyer) == PRICE + BOND, "missing withdrawal ledger");
        require(escrow.locked() == 0 && escrow.outstanding() == 0, "remaining liabilities");
        vm.expectRevert(Escrow.NoCredit.selector);
        vm.prank(buyer);
        escrow.withdraw(ORDER_ID);
        vm.expectRevert(Escrow.InvalidState.selector);
        escrow.timeout(ORDER_ID);
        conserved();
    }

    function testDemoTwoVoteSettlementPaysPriceAndReturnsBond() public {
        fund();
        certify();
        escrow.settle(ORDER_ID);
        require(state() == Escrow.State.ALLOCATED_PAID, "wrong settlement state");
        require(escrow.credits(ORDER_ID, buyer) == BOND && escrow.credits(ORDER_ID, seller) == PRICE, "wrong payout allocation");
        conserved();
        vm.prank(seller);
        escrow.withdraw(ORDER_ID);
        vm.prank(buyer);
        escrow.withdraw(ORDER_ID);
        require(token.balanceOf(seller) == PRICE && token.balanceOf(buyer) == token.INITIAL_SUPPLY() - PRICE, "wrong final payout");
        require(escrow.outstanding() == 0, "remaining payable credits");
        conserved();
    }

    function testDemoCertifiedTimeoutRefundsPriceAndCompensatesBond() public {
        fund();
        certify();
        vm.warp(3001);
        escrow.timeout(ORDER_ID);
        require(state() == Escrow.State.ALLOCATED_COMPENSATION, "wrong compensation state");
        require(escrow.credits(ORDER_ID, buyer) == PRICE && escrow.credits(ORDER_ID, seller) == BOND, "wrong compensation allocation");
        conserved();
        vm.prank(buyer);
        escrow.withdraw(ORDER_ID);
        vm.prank(seller);
        escrow.withdraw(ORDER_ID);
        require(token.balanceOf(buyer) == token.INITIAL_SUPPLY() - BOND && token.balanceOf(seller) == BOND, "wrong final compensation");
        require(escrow.outstanding() == 0, "remaining payable credits");
        conserved();
    }
}
