// SPDX-License-Identifier: MIT

pragma solidity ^0.8.11;

interface IRepaymentController {
    // ============== Lifeycle Operations ==============

    function repay(uint256 loanId) external;

    function forceRepay(uint256 loanId) external;

    function claim(uint256 loanId) external;
}
