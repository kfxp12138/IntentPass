// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @notice Test-use-only asset for IntentPass demonstrations. It has no promised economic value.
/// @dev The entire finite supply is minted once to the constructor recipient.
/// There are no external mint, burn, ownership, or administrative functions.
contract IntentPassDemoToken is ERC20 {
    error InvalidRecipient();

    uint256 public constant INITIAL_SUPPLY = 1_000_000 * 1e6;

    constructor(address initialRecipient) ERC20("IntentPass TEST ONLY Demo Token", "IPTEST") {
        if (initialRecipient == address(0)) revert InvalidRecipient();
        _mint(initialRecipient, INITIAL_SUPPLY);
    }

    function decimals() public pure override returns (uint8) {
        return 6;
    }
}
