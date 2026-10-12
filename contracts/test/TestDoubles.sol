// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IAssetEligibility} from "../src/IAssetEligibility.sol";

// TEST_DOUBLE ONLY: not a real CVA or Cleanverse registry. Never deployed by release scripts.
contract TestAsset is ERC20 {
    uint8 public failureMode;
    constructor() ERC20("IntentPass LOCAL TEST DOUBLE", "TEST_ONLY") {}
    function mint(address who,uint256 amount) external {_mint(who,amount);}
    function setFailure(uint8 mode) external {failureMode=mode;}
    function transfer(address to,uint256 amount) public override returns(bool) {
        if(failureMode==1) revert("TEST_TRANSFER_REVERT");
        if(failureMode==2) return false;
        bool ok=super.transfer(to,amount);if(failureMode==3 && amount>0) _burn(to,1);return ok;
    }
    function transferFrom(address from,address to,uint256 amount) public override returns(bool) {
        if(failureMode==1) revert("TEST_TRANSFER_REVERT");
        if(failureMode==2) return false;
        bool ok=super.transferFrom(from,to,amount);if(failureMode==3 && amount>0) _burn(to,1);return ok;
    }
}
contract TestEligibility is IAssetEligibility {
    mapping(address=>bool) public denied;
    bool public unavailable;
    function deny(address who,bool value) external {denied[who]=value;}
    function setUnavailable(bool value) external {unavailable=value;}
    function canTransfer(address,address from,address to,uint256,bytes32) external view returns(bool) {
        if(unavailable) revert("TEST_GATE_UNAVAILABLE");return !denied[from]&&!denied[to];
    }
}
