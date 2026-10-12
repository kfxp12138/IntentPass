// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;
import {IAssetEligibility} from "./IAssetEligibility.sol";

/// @notice Original read-only bridge to interfaces documented in the supplied
/// Cleanverse CVI V2 (pp. 2-3), CVA (p. 8) and Wrapped CVA (p. 10) guides.
/// This is not an official validator, identity registry or asset implementation.
contract CleanverseEligibility is IAssetEligibility {
    address public immutable asset;
    address public immutable validator;
    address public immutable policy;
    address public immutable pool;
    error InvalidConfiguration();

    constructor(address asset_,address validator_,address policy_,address pool_) {
        if(asset_.code.length==0||validator_.code.length==0||policy_.code.length==0||pool_==address(0)) revert InvalidConfiguration();
        asset=asset_;validator=validator_;policy=policy_;pool=pool_;
        // The escrow can be a predicted CREATE address: it requires this gate
        // already deployed. Official registration is checked at use, never assumed.
    }

    function canTransfer(address token,address from,address to,uint256 amount,bytes32)
        external view returns(bool) {
        if(token!=asset||from==address(0)||to==address(0)||amount==0||(from!=pool&&to!=pool))return false;
        (bool available,uint256 linked)=_word(asset,abi.encodeWithSignature("policy()"));
        if(!available||linked!=uint256(uint160(policy)))return false;
        if(!_allows(validator,abi.encodeWithSignature("isRegistered(address)",pool)))return false;
        if(!_allows(validator,abi.encodeWithSignature("complianceVerify(address,address)",pool,from)))return false;
        if(!_allows(validator,abi.encodeWithSignature("complianceVerify(address,address)",pool,to)))return false;
        return _allows(policy,abi.encodeWithSignature("canTransfer(address,address,address,uint256)",asset,from,to,amount));
        // contextHash is enforced by ContextVoteEscrow, not the official policy.
    }

    function _allows(address target,bytes memory data) private view returns(bool) {
        (bool available,uint256 value)=_word(target,data);return available&&value==1;
    }
    function _word(address target,bytes memory data) private view returns(bool available,uint256 value) {
        // Bound the copied return data and reject missing/noncanonical responses.
        assembly ("memory-safe") {
            let output := mload(0x40)
            mstore(output,0)
            available := staticcall(gas(),target,add(data,32),mload(data),output,32)
            available := and(available,eq(returndatasize(),32))
            value := mload(output)
        }
    }
}
