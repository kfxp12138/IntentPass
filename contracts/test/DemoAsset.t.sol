// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IERC20Errors} from "@openzeppelin/contracts/interfaces/draft-IERC6093.sol";
import {IntentPassDemoToken} from "../src/IntentPassDemoToken.sol";
import {FixedAssetEligibility} from "../src/FixedAssetEligibility.sol";

interface DemoAssetVm {
    function prank(address) external;
    function expectRevert(bytes4) external;
    function expectRevert(bytes calldata) external;
}

contract IntentPassDemoTokenTest {
    DemoAssetVm constant vm = DemoAssetVm(address(uint160(uint256(keccak256("hevm cheat code")))));
    address constant RECIPIENT = address(0x101);
    address constant PAYEE = address(0x102);
    address constant SPENDER = address(0x103);
    IntentPassDemoToken token;

    function setUp() public {
        token = new IntentPassDemoToken(RECIPIENT);
    }

    function testConstructorAllocatesOnlyFixedSixDecimalSupplyToRecipient() public view {
        require(token.decimals() == 6, "wrong decimals");
        require(token.INITIAL_SUPPLY() == 1_000_000 * 1e6, "wrong initial supply");
        require(token.totalSupply() == token.INITIAL_SUPPLY(), "wrong total supply");
        require(token.balanceOf(RECIPIENT) == token.totalSupply(), "recipient was not funded");
        require(token.balanceOf(address(this)) == 0 && token.balanceOf(address(token)) == 0, "other allocation");
        require(keccak256(bytes(token.name())) == keccak256("IntentPass TEST ONLY Demo Token"), "test label missing");
        require(keccak256(bytes(token.symbol())) == keccak256("IPTEST"), "wrong symbol");
    }

    function testConstructorRejectsZeroRecipient() public {
        vm.expectRevert(IntentPassDemoToken.InvalidRecipient.selector);
        new IntentPassDemoToken(address(0));
    }

    function testExternalMintBurnAndAdministrativeCallsAreUnavailable() public {
        bytes[5] memory calls = [
            abi.encodeWithSignature("mint(address,uint256)", PAYEE, 1e6),
            abi.encodeWithSignature("burn(uint256)", 1e6),
            abi.encodeWithSignature("setFailure(uint8)", uint8(1)),
            abi.encodeWithSignature("transferOwnership(address)", PAYEE),
            abi.encodeWithSignature("grantRole(bytes32,address)", bytes32(0), PAYEE)
        ];
        for (uint256 i = 0; i < calls.length; i++) {
            vm.prank(RECIPIENT);
            (bool ok,) = address(token).call(calls[i]);
            require(!ok, "unexpected external supply/admin function");
        }
        require(token.totalSupply() == token.INITIAL_SUPPLY(), "supply changed");
        require(token.balanceOf(RECIPIENT) == token.INITIAL_SUPPLY(), "recipient balance changed");
        require(token.balanceOf(PAYEE) == 0, "unexpected mint");
    }

    function testNormalTransfersUseExactAmountsAndConsumeApproval() public {
        vm.prank(RECIPIENT);
        require(token.transfer(PAYEE, 3e6));
        vm.prank(RECIPIENT);
        require(token.approve(SPENDER, 2e6));
        vm.prank(SPENDER);
        require(token.transferFrom(RECIPIENT, PAYEE, 2e6));
        require(token.balanceOf(PAYEE) == 5e6, "recipient delta mismatch");
        require(token.balanceOf(RECIPIENT) == token.INITIAL_SUPPLY() - 5e6, "sender delta mismatch");
        require(token.allowance(RECIPIENT, SPENDER) == 0, "approval not consumed");
        require(token.totalSupply() == token.INITIAL_SUPPLY(), "supply changed");
    }

    function testTransferFromStillRequiresHolderApproval() public {
        vm.expectRevert(abi.encodeWithSelector(IERC20Errors.ERC20InsufficientAllowance.selector, SPENDER, 0, 1e6));
        vm.prank(SPENDER);
        token.transferFrom(RECIPIENT, PAYEE, 1e6);
        require(token.balanceOf(RECIPIENT) == token.INITIAL_SUPPLY(), "unauthorized debit");
        require(token.balanceOf(PAYEE) == 0, "unauthorized credit");
    }

    function testFuzzTransfersConserveFixedSupply(uint256 amount) public {
        amount %= token.INITIAL_SUPPLY() + 1;
        vm.prank(RECIPIENT);
        require(token.transfer(PAYEE, amount));
        require(token.balanceOf(RECIPIENT) + token.balanceOf(PAYEE) == token.INITIAL_SUPPLY(), "balances not conserved");
        require(token.totalSupply() == token.INITIAL_SUPPLY(), "supply changed");
    }
}

contract FixedAssetEligibilityTest {
    DemoAssetVm constant vm = DemoAssetVm(address(uint160(uint256(keccak256("hevm cheat code")))));
    address constant BUYER = address(0x201);
    address constant PAYEE = address(0x202);
    IntentPassDemoToken token;
    FixedAssetEligibility gate;

    function setUp() public {
        token = new IntentPassDemoToken(BUYER);
        gate = new FixedAssetEligibility(address(token));
    }

    function testConstructorRequiresAssetCode() public {
        vm.expectRevert(FixedAssetEligibility.InvalidAsset.selector);
        new FixedAssetEligibility(address(0));
        vm.expectRevert(FixedAssetEligibility.InvalidAsset.selector);
        new FixedAssetEligibility(BUYER);
        require(gate.asset() == address(token), "wrong fixed asset");
    }

    function testDifferentDeployedAssetCannotUseTheGate() public {
        IntentPassDemoToken anotherAsset = new IntentPassDemoToken(BUYER);
        require(!gate.canTransfer(address(anotherAsset), BUYER, PAYEE, 1e6, bytes32(0)), "other token permitted");
        require(!gate.canTransfer(address(0), BUYER, PAYEE, 1e6, bytes32(0)), "zero asset permitted");
    }

    function testZeroEndpointsAndZeroAmountAreRejected() public view {
        require(!gate.canTransfer(address(token), address(0), PAYEE, 1e6, bytes32(0)), "zero sender permitted");
        require(!gate.canTransfer(address(token), BUYER, address(0), 1e6, bytes32(0)), "zero recipient permitted");
        require(!gate.canTransfer(address(token), BUYER, PAYEE, 0, bytes32(0)), "zero amount permitted");
    }

    function testOrdinaryEOAsAndContractActorsNeedNoRegistration() public view {
        require(BUYER.code.length == 0 && PAYEE.code.length == 0, "expected EOA actors");
        require(gate.canTransfer(address(token), BUYER, PAYEE, 1e6, bytes32(0)), "EOAs blocked");
        require(gate.canTransfer(address(token), BUYER, address(this), 1e6, bytes32(0)), "contract funding blocked");
        require(gate.canTransfer(address(token), address(this), PAYEE, 1e6, bytes32(0)), "contract payout blocked");
        // This is a fixed-asset constraint, not a balance or identity authorization.
        require(token.balanceOf(PAYEE) == 0);
        require(gate.canTransfer(address(token), PAYEE, BUYER, token.INITIAL_SUPPLY() + 1, bytes32(0)), "gate added an unstated balance check");
    }

    function testNoExternalAssetReplacementOrIdentityConfiguration() public {
        (bool replaced,) = address(gate).call(abi.encodeWithSignature("setAsset(address)", address(this)));
        (bool denied,) = address(gate).call(abi.encodeWithSignature("deny(address,bool)", BUYER, true));
        require(!replaced && !denied, "unexpected mutable gate configuration");
        require(gate.asset() == address(token), "fixed asset changed");
        require(gate.canTransfer(address(token), BUYER, PAYEE, 1e6, bytes32(0)), "ordinary actor was denied");
    }

    function testFuzzPositiveAmountsDoNotDependOnContext(uint256 amount, bytes32 contextHash) public view {
        amount = amount / 2 + 1;
        require(gate.canTransfer(address(token), BUYER, PAYEE, amount, contextHash), "context introduced identity restrictions");
    }
}
